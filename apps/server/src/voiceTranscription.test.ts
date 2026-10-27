import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it, vi } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  CodexSettings,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  VOICE_TRANSCRIPTION_MAX_REQUEST_BODY_BYTES,
  VOICE_PREWARM_MAX_REQUEST_BODY_BYTES,
  VOICE_TRANSCRIPTION_MAX_RESPONSE_BYTES,
} from "@goat/contracts";
import { encodeMonoPcm16Wav, uint8ArrayToBase64 } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { Etag, HttpPlatform, FetchHttpClient, HttpRouter } from "effect/http";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as VoiceTranscription from "./voiceTranscription.ts";
import {
  ProjectionStoreV2,
  ProjectionStoreThreadNotFoundError,
} from "./orchestration-v2/ProjectionStore.ts";
import { ProjectStoreV2 } from "./orchestration-v2/ProjectStore.ts";
import * as ProviderCredentialStore from "./provider/ProviderCredentialStore.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import { makeCodexChatGptAuth } from "./provider/CodexChatGptAuth.ts";
import { ServerSettingsService } from "./serverSettings.ts";

class VoiceTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.voice) {}

const decodeSettings = Schema.decodeEffect(CodexSettings);

function audioInput(mutate?: (view: DataView) => void) {
  const wav = encodeMonoPcm16Wav([new Float32Array(24_000)], 24_000)!;
  mutate?.(new DataView(wav.bytes.buffer));
  return {
    audioBase64: uint8ArrayToBase64(wav.bytes),
    mimeType: "audio/wav",
    sampleRateHz: 24_000,
    durationMs: 1_000,
  };
}

const serve = Effect.fn("test.voice.serve")(function* (
  options: {
    operate?: boolean;
    env?: NodeJS.ProcessEnv;
    config?: unknown;
    fetch?: typeof fetch;
    configFile?: unknown;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped();
  if (options.configFile)
    yield* fs.writeFileString(`${home}/config.json`, JSON.stringify(options.configFile));
  const calls: { url: string; init: RequestInit }[] = [];
  const tokens: boolean[] = [];
  const resolved = vi.fn();
  const layerAuth = Layer.succeed(EnvironmentAuthenticatedAuth, (effect) =>
    effect.pipe(
      Effect.provideService(EnvironmentAuthenticatedPrincipal, {
        scopes: new Set(options.operate === false ? [] : [AuthOrchestrationOperateScope]),
      } as unknown as EnvironmentAuthenticatedPrincipal["Service"]),
    ),
  );
  const http = FetchHttpClient.layer.pipe(
    Layer.provide(
      Layer.succeed(FetchHttpClient.Fetch, (async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return options.fetch ? options.fetch(url, init) : Response.json({ text: "voice draft" });
      }) as typeof fetch),
    ),
  );
  const selectedSettings = yield* decodeSettings(options.config ?? {});
  const sessions = Layer.succeed(VoiceTranscription.VoiceSessions, {
    resolve: () =>
      Effect.sync(() => {
        resolved();
        return {
          settings: selectedSettings,
          token: (refresh: boolean) =>
            Effect.sync(() => {
              tokens.push(refresh);
              return refresh ? "renewed-session-token" : "session-token";
            }),
        };
      }),
  });
  const app = HttpApiBuilder.layer(VoiceTestApi).pipe(
    Layer.provide(VoiceTranscription.layerHttp),
    Layer.provide(layerAuth),
    Layer.provide(sessions),
    Layer.provide(http),
    Layer.provide(Layer.succeed(HostProcess.Environment, { OPENCODEX_HOME: home, ...options.env })),
    Layer.provideMerge(
      HttpPlatform.layer.pipe(
        Layer.provideMerge(Etag.layerWeak),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(app, { disableLogger: true });
  yield* Effect.addFinalizer(() => Effect.promise(() => dispose()));
  return {
    calls,
    tokens,
    resolved,
    send: (
      body: unknown = audioInput(),
      path = "transcribe",
      headers: Record<string, string> = {},
    ) =>
      Effect.promise(() =>
        handler(
          new Request(`http://localhost/api/voice/${path}`, {
            method: "POST",
            headers: { "content-type": "application/json", ...headers },
            body: typeof body === "string" ? body : JSON.stringify(body),
          }),
          Context.empty(),
        ),
      ),
    stream: (
      body: ReadableStream<Uint8Array>,
      path: string,
      headers: Record<string, string> = {},
    ) =>
      Effect.promise(() =>
        handler(
          new Request(`http://localhost/api/voice/${path}`, {
            method: "POST",
            headers: { "content-type": "application/json", ...headers },
            body,
            duplex: "half",
          } as RequestInit),
          Context.empty(),
        ),
      ),
  };
});

it.layer(NodeServices.layer)("mounted voice API", (it) => {
  it.effect.each(["transcribe", "prewarm"])("requires operate scope before reading %s", (path) =>
    Effect.gen(function* () {
      const h = yield* serve({ operate: false });
      let pulled = 0;
      const body = new ReadableStream<Uint8Array>(
        {
          pull() {
            pulled++;
          },
        },
        { highWaterMark: 0 },
      );
      const result = yield* h.stream(body, path);
      expect(result.status).toBe(403);
      expect(pulled).toBe(0);
      expect(h.resolved).not.toHaveBeenCalled();
      expect(h.calls).toHaveLength(0);
    }),
  );

  it.effect.each([
    ["magic", (v: DataView) => v.setUint32(0, 0)],
    ["stereo", (v: DataView) => v.setUint16(22, 2, true)],
    ["rate", (v: DataView) => v.setUint32(24, 16_000, true)],
    ["format", (v: DataView) => v.setUint16(20, 3, true)],
    ["bits", (v: DataView) => v.setUint16(34, 8, true)],
    ["align", (v: DataView) => v.setUint16(32, 4, true)],
    ["byte rate", (v: DataView) => v.setUint32(28, 32_000, true)],
    ["odd data", (v: DataView) => v.setUint32(40, 47_999, true)],
    ["empty data", (v: DataView) => v.setUint32(40, 0, true)],
    ["short riff boundary", (v: DataView) => v.setUint32(4, 36, true)],
  ] as const)("rejects invalid WAV %s before resolving credentials", ([_, mutate]) =>
    Effect.gen(function* () {
      const h = yield* serve();
      const response = yield* h.send(audioInput(mutate));
      expect(response.status).toBe(400);
      expect(yield* Effect.promise(() => response.json())).toMatchObject({ code: "invalid-audio" });
      expect(h.resolved).not.toHaveBeenCalled();
      expect(h.calls).toHaveLength(0);
    }),
  );

  it.effect.each(["duration", "base64", "json"])("rejects invalid %s without uploading", (kind) =>
    Effect.gen(function* () {
      const h = yield* serve();
      const input = audioInput();
      const body =
        kind === "json"
          ? "{"
          : {
              ...input,
              ...(kind === "duration" ? { durationMs: 1_251 } : { audioBase64: "!!!!" }),
            };
      expect((yield* h.send(body)).status).toBe(400);
      expect(h.calls).toHaveLength(0);
    }),
  );

  it.effect.each([
    { env: { OPENCODEX_API_AUTH_TOKEN: " token-key " }, key: "token-key" },
    {
      env: { GOAT_OPENCODEX_API_KEY: "goat-key", OPENCODEX_API_AUTH_TOKEN: "token-key" },
      key: "goat-key",
    },
    { configFile: { apiKeys: [{ key: "file-key" }] }, key: "file-key" },
    {
      configFile: {
        apiKeys: [{ pendingRotation: { key: "rotation-key", expiresAt: "9999-01-01T00:00:00Z" } }],
      },
      key: "rotation-key",
    },
  ])("uses admission key $key and normalizes the OpenCodex URL", (config) =>
    Effect.gen(function* () {
      const h = yield* serve({
        ...config,
        env: { ...config.env, GOAT_OPENCODEX_BASE_URL: "http://127.0.0.1:10100/v1/" },
      });
      const response = yield* h.send({ ...audioInput(), locale: "ko-KR", prompt: "project words" });
      expect(response.status).toBe(200);
      expect(yield* Effect.promise(() => response.json())).toEqual({
        text: "voice draft",
        route: "opencodex",
      });
      expect(h.calls[0]!.url).toBe("http://127.0.0.1:10100/v1/audio/transcriptions");
      expect(new Headers(h.calls[0]!.init.headers).get("x-opencodex-api-key")).toBe(config.key);
      const form = h.calls[0]!.init.body as FormData;
      expect(form.get("model")).toBe("gpt-4o-transcribe");
      expect(form.get("response_format")).toBe("json");
      expect(form.get("language")).toBe("ko");
      expect(form.get("prompt")).toBe("project words");
      const file = form.get("file") as File;
      expect(file.name).toBe("voice.wav");
      expect(file.type).toBe("audio/wav");
      expect(new Uint8Array(yield* Effect.promise(() => file.arrayBuffer()))).toHaveLength(48_044);
      expect(h.tokens).toEqual([]);
    }),
  );

  it.effect("uses selected Codex OpenCodex settings without an environment URL", () =>
    Effect.gen(function* () {
      const h = yield* serve({
        config: { modelRoute: "opencodex", opencodexBaseUrl: "http://localhost:10100/v1/" },
        env: { OPENCODEX_API_AUTH_TOKEN: "key" },
      });
      expect((yield* h.send()).status).toBe(200);
      expect(h.calls[0]!.url).toBe("http://localhost:10100/v1/audio/transcriptions");
    }),
  );

  it.effect.each([401, 403])("fails closed on OpenCodex %i without trying a session", (status) =>
    Effect.gen(function* () {
      const h = yield* serve({
        env: {
          GOAT_OPENCODEX_BASE_URL: "http://localhost:10100/v1/",
          OPENCODEX_API_AUTH_TOKEN: "bad-key",
        },
        fetch: async () => new Response("rejected", { status }),
      });
      const response = yield* h.send();
      expect(response.status).toBe(502);
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        code: "upstream-auth-expired",
        retryable: false,
      });
      expect(h.calls).toHaveLength(1);
      expect(h.tokens).toEqual([]);
    }),
  );

  it.effect.each(["missing", "refused", "expired-rotation"])(
    "falls back only for %s OpenCodex admission",
    (kind) =>
      Effect.gen(function* () {
        const h = yield* serve({
          env: {
            GOAT_OPENCODEX_BASE_URL: "http://localhost:10100/v1/",
            ...(kind === "refused" ? { OPENCODEX_API_AUTH_TOKEN: "key" } : {}),
          },
          ...(kind === "expired-rotation"
            ? {
                configFile: {
                  apiKeys: [
                    { pendingRotation: { key: "expired", expiresAt: "2000-01-01T00:00:00Z" } },
                  ],
                },
              }
            : {}),
          fetch: async (url) => {
            if (String(url).includes("localhost"))
              throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
            return Response.json({ text: "session draft" });
          },
        });
        const response = yield* h.send();
        expect(response.status).toBe(200);
        expect(yield* Effect.promise(() => response.json())).toMatchObject({
          route: "chatgpt-session",
        });
        expect(h.calls.at(-1)!.url).toBe("https://chatgpt.com/backend-api/transcribe");
        expect(h.tokens).toEqual([false]);
      }),
  );

  it.effect("does not fall back on other transport failures", () =>
    Effect.gen(function* () {
      const h = yield* serve({
        env: {
          GOAT_OPENCODEX_BASE_URL: "http://localhost:10100/v1/",
          OPENCODEX_API_AUTH_TOKEN: "key",
        },
        fetch: async () => {
          throw new TypeError("fetch failed", { cause: { code: "ETIMEDOUT" } });
        },
      });
      expect((yield* h.send()).status).toBe(502);
      expect(h.tokens).toEqual([]);
      expect(h.calls).toHaveLength(1);
    }),
  );

  it.effect.each([401, 403])("refreshes a rejected ChatGPT %i once on the same session", (status) =>
    Effect.gen(function* () {
      let count = 0;
      const h = yield* serve({
        fetch: async () =>
          ++count === 1 ? new Response("", { status }) : Response.json({ text: "renewed draft" }),
      });
      expect((yield* h.send()).status).toBe(200);
      expect(h.tokens).toEqual([false, true]);
      expect(h.calls.map((call) => new Headers(call.init.headers).get("authorization"))).toEqual([
        "Bearer session-token",
        "Bearer renewed-session-token",
      ]);
      expect(
        h.calls.every((call) => call.url === "https://chatgpt.com/backend-api/transcribe"),
      ).toBe(true);
    }),
  );

  it.effect("does not refresh or switch account after a second rejection", () =>
    Effect.gen(function* () {
      const h = yield* serve({ fetch: async () => new Response("", { status: 401 }) });
      const response = yield* h.send();
      expect(response.status).toBe(502);
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        code: "upstream-auth-expired",
        retryable: false,
      });
      expect(h.tokens).toEqual([false, true]);
      expect(h.calls).toHaveLength(2);
    }),
  );

  it.effect.each([
    ["transcribe", VOICE_TRANSCRIPTION_MAX_REQUEST_BODY_BYTES],
    ["prewarm", VOICE_PREWARM_MAX_REQUEST_BODY_BYTES],
  ] as const)("rejects declared oversized %s before pulling any body", ([path, cap]) =>
    Effect.gen(function* () {
      const h = yield* serve();
      let pulled = 0;
      const body = new ReadableStream<Uint8Array>(
        {
          pull() {
            pulled++;
          },
        },
        { highWaterMark: 0 },
      );
      const response = yield* h.stream(body, path, { "content-length": String(cap + 1) });
      expect(response.status).toBe(413);
      expect(yield* Effect.promise(() => response.json())).toMatchObject({ code: "invalid-audio" });
      expect(pulled).toBe(0);
      expect(h.resolved).not.toHaveBeenCalled();
    }),
  );

  it.effect.each([
    ["transcribe", VOICE_TRANSCRIPTION_MAX_REQUEST_BODY_BYTES, false],
    ["prewarm", VOICE_PREWARM_MAX_REQUEST_BODY_BYTES, false],
    ["transcribe", VOICE_TRANSCRIPTION_MAX_REQUEST_BODY_BYTES, true],
  ] as const)("bounds chunked %s before JSON parsing (lying length=%s)", ([path, cap, lying]) =>
    Effect.gen(function* () {
      const h = yield* serve();
      let cancelled = false;
      let pulls = 0;
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulls++;
            controller.enqueue(new Uint8Array(cap / 2 + 1).fill(123));
          },
          cancel() {
            cancelled = true;
          },
        },
        { highWaterMark: 0 },
      );
      const response = yield* h.stream(body, path, lying ? { "content-length": "1" } : {});
      expect(response.status).toBe(413);
      expect(cancelled).toBe(true);
      expect(pulls).toBe(2);
      expect(h.resolved).not.toHaveBeenCalled();
      expect(h.calls).toHaveLength(0);
    }),
  );

  it.effect.each([true, false])(
    "bounds upstream responses and releases the stream (length=%s)",
    (declared) =>
      Effect.gen(function* () {
        let cancelled = false;
        let pulls = 0;
        let aborted = false;
        const h = yield* serve({
          fetch: async (_url, init) => {
            init?.signal?.addEventListener("abort", () => {
              aborted = true;
            });
            return new Response(
              new ReadableStream<Uint8Array>(
                {
                  pull(controller) {
                    pulls++;
                    controller.enqueue(
                      new Uint8Array(VOICE_TRANSCRIPTION_MAX_RESPONSE_BYTES / 2 + 1),
                    );
                  },
                  cancel() {
                    cancelled = true;
                  },
                },
                { highWaterMark: 0 },
              ),
              {
                headers: declared
                  ? { "content-length": String(VOICE_TRANSCRIPTION_MAX_RESPONSE_BYTES + 1) }
                  : {},
              },
            );
          },
        });
        const response = yield* h.send();
        expect(response.status).toBe(502);
        expect(yield* Effect.promise(() => response.json())).toMatchObject({
          code: "upstream-failed",
        });
        expect(aborted).toBe(true);
        expect(declared ? pulls === 0 : cancelled).toBe(true);
      }),
  );

  it.effect("prewarms only credentials and never uploads audio", () =>
    Effect.gen(function* () {
      const h = yield* serve();
      const response = yield* h.send({}, "prewarm");
      expect(response.status).toBe(200);
      expect(yield* Effect.promise(() => response.json())).toEqual({
        ready: true,
        route: "chatgpt-session",
      });
      expect(h.tokens).toEqual([false]);
      expect(h.calls).toHaveLength(0);
    }),
  );
});

it.layer(NodeServices.layer)("forced ChatGPT credential renewal", (it) => {
  it.effect("renews before local expiry and coalesces retries for the rejected token", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("voice-refresh-test");
      const bytes = new Map<string, Uint8Array>();
      const secrets = ServerSecretStore.ServerSecretStore.of({
        get: (key) => Effect.sync(() => Option.fromUndefinedOr(bytes.get(key))),
        set: (key, value) =>
          Effect.sync(() => {
            bytes.set(key, value);
          }),
        remove: (key) =>
          Effect.sync(() => {
            bytes.delete(key);
          }),
        create: () => Effect.die("unused"),
        getOrCreateRandom: () => Effect.die("unused"),
      });
      let refreshes = 0;
      const fetchFn: typeof fetch = async (url, init) => {
        if (String(url).endsWith("discovery"))
          return Response.json({
            issuer: "https://auth.test",
            authorization_endpoint: "https://auth.test/authorize",
            token_endpoint: "https://auth.test/token",
            jwks_uri: "https://auth.test/jwks",
          });
        const form = new URLSearchParams(String(init?.body));
        expect(form.get("grant_type")).toBe("refresh_token");
        expect(form.get("client_id")).toBe("oaiapp_voice");
        refreshes++;
        return Response.json({
          access_token: "new-access",
          refresh_token: "new-refresh",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "chatgpt.tokens.use.direct",
        });
      };
      yield* Effect.gen(function* () {
        const store = yield* ProviderCredentialStore.make("codex-chatgpt", instanceId);
        const credentials = {
          clientId: "oaiapp_voice",
          accessToken: "still-locally-valid",
          refreshToken: "refresh-token",
          expiresAt: (yield* Clock.currentTimeMillis) + 3_600_000,
          earliestRefreshAt: null,
          scopes: ["chatgpt.tokens.use.direct"],
          subject: "voice-account",
          email: null,
        };
        yield* store.set(new TextEncoder().encode(JSON.stringify(credentials)));
        const auth = yield* makeCodexChatGptAuth({
          instanceId,
          discoveryUrl: "https://auth.test/discovery",
        });
        const initial = yield* auth.access;
        expect(initial.accessToken).toBe("still-locally-valid");
        expect(refreshes).toBe(0);
        const renewed = yield* auth.refreshAccess(initial);
        expect(renewed.accessToken).toBe("new-access");
        expect((yield* auth.refreshAccess(initial)).accessToken).toBe("new-access");
        expect(refreshes).toBe(1);
        // A changed profile must never refresh or supply another account's token.
        const changed = { ...renewed, subject: "different-account" };
        yield* store.set(new TextEncoder().encode(JSON.stringify(changed)));
        expect((yield* auth.refreshAccess(renewed).pipe(Effect.flip)).operation).toBe("access");
        expect(refreshes).toBe(1);
      }).pipe(
        Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
        Effect.provideService(ServerEnvironment.ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(EnvironmentId.make("voice-environment")),
        }),
        Effect.provide(
          FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchFn))),
        ),
      );
    }),
  );

  it.effect(
    "enforces threadId readability, workspace cwd containment, and non-Codex fallback in layerSessions",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const workspace = yield* fs.makeTempDirectoryScoped();
        const subdir = `${workspace}/sub`;
        const outside = yield* fs.makeTempDirectoryScoped();
        yield* fs.makeDirectory(subdir, { recursive: true });
        const threadId = ThreadId.make("thread-valid");
        const deletedId = ThreadId.make("thread-deleted");
        const projectId = ProjectId.make("project-1");
        const codexId = ProviderInstanceId.make("codex");
        const claudeId = ProviderInstanceId.make("claude");
        const secretsMap = new Map<string, Uint8Array>();
        const secrets = ServerSecretStore.ServerSecretStore.of({
          get: (key) => Effect.sync(() => Option.fromUndefinedOr(secretsMap.get(key))),
          set: (key, value) =>
            Effect.sync(() => {
              secretsMap.set(key, value);
            }),
          remove: (key) =>
            Effect.sync(() => {
              secretsMap.delete(key);
            }),
          create: () => Effect.die("unused"),
          getOrCreateRandom: () => Effect.die("unused"),
        });
        const sessionLayer = VoiceTranscription.layerSessions.pipe(
          Layer.provide(
            Layer.succeed(ServerSettingsService, {
              getSettings: Effect.succeed({
                defaultModelSelection: {
                  provider: "claude",
                  instanceId: claudeId,
                  model: "claude-4",
                },
                providerInstances: {
                  [claudeId]: { driver: "claude", enabled: true, config: {} },
                  [codexId]: {
                    driver: "codex",
                    enabled: true,
                    config: {
                      enabled: true,
                      setupMode: "managed",
                      modelRoute: "opencodex",
                      opencodexBaseUrl: "http://127.0.0.1:10100/v1",
                    },
                  },
                },
              } as unknown as Effect.Success<ServerSettingsService["Service"]["getSettings"]>),
            } as unknown as ServerSettingsService["Service"]),
          ),
          Layer.provide(
            Layer.succeed(ProjectionStoreV2, {
              getThread: (id: ThreadId) =>
                id === threadId
                  ? Effect.succeed({
                      id: threadId,
                      projectId,
                      worktreePath: null,
                      deletedAt: null,
                      modelSelection: {
                        provider: "claude",
                        instanceId: claudeId,
                        model: "claude-4",
                      },
                    } as never)
                  : id === deletedId
                    ? Effect.succeed({
                        id: deletedId,
                        projectId,
                        worktreePath: null,
                        deletedAt: "2026-10-27T00:00:00Z",
                        modelSelection: {
                          provider: "claude",
                          instanceId: claudeId,
                          model: "claude-4",
                        },
                      } as never)
                    : Effect.fail(new ProjectionStoreThreadNotFoundError({ threadId: id })),
            } as unknown as ProjectionStoreV2["Service"]),
          ),
          Layer.provide(
            Layer.succeed(ProjectStoreV2, {
              get: (id: ProjectId) =>
                Effect.succeed(
                  id === projectId
                    ? Option.some({ projectId, workspaceRoot: workspace } as never)
                    : Option.none(),
                ),
              listShells: () =>
                Effect.succeed([{ id: projectId, workspaceRoot: workspace } as never]),
            } as unknown as ProjectStoreV2["Service"]),
          ),
          Layer.provide(Layer.succeed(ServerSecretStore.ServerSecretStore, secrets)),
          Layer.provide(
            Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
              getEnvironmentId: Effect.succeed(EnvironmentId.make("voice-environment")),
            }),
          ),
          Layer.provide(FetchHttpClient.layer),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const sessions = yield* VoiceTranscription.VoiceSessions;
            const unknownThread = yield* sessions
              .resolve({ threadId: ThreadId.make("thread-missing") })
              .pipe(Effect.flip);
            expect(unknownThread._tag).toBe("EnvironmentHttpForbiddenError");
            const deletedThread = yield* sessions
              .resolve({ threadId: deletedId })
              .pipe(Effect.flip);
            expect(deletedThread._tag).toBe("EnvironmentHttpForbiddenError");
            const outsideCwd = yield* sessions
              .resolve({ threadId, cwd: outside as never })
              .pipe(Effect.flip);
            expect(outsideCwd._tag).toBe("EnvironmentHttpForbiddenError");
            const resolved = yield* sessions.resolve({
              threadId,
              providerInstanceId: claudeId,
              cwd: subdir as never,
            });
            expect(resolved.settings.modelRoute).toBe("opencodex");
          }).pipe(Effect.provide(sessionLayer)),
        );
      }),
  );
});
