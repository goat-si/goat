import {
  AuthOrchestrationOperateScope,
  CodexSettings,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  EnvironmentHttpForbiddenError,
  ProviderInstanceId,
  VOICE_PREWARM_MAX_REQUEST_BODY_BYTES,
  VOICE_TRANSCRIPTION_MAX_REQUEST_BODY_BYTES,
  VOICE_TRANSCRIPTION_MAX_RESPONSE_BYTES,
  VoicePrewarmInput,
  VoiceTranscriptionBadRequestError,
  VoiceTranscriptionInput,
  VoiceTranscriptionPayloadTooLargeError,
  VoiceTranscriptionUpstreamError,
  type VoiceTranscriptionErrorCode,
} from "@goat/contracts";
import { base64ToUint8Array, validateCanonicalVoiceWav } from "@goat/contracts";
import { mergeProviderInstanceEnvironment } from "@goat/provider-core/server/instanceEnvironment";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpServerRequest,
} from "effect/http";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { ProjectionStoreV2 } from "./orchestration-v2/ProjectionStore.ts";
import { ProjectStoreV2 } from "./orchestration-v2/ProjectStore.ts";
import { makeCodexChatGptAuth } from "./provider/CodexChatGptAuth.ts";
import { withCodexAppServerClient } from "./provider/CodexProvider.ts";
import { resolveCodexHomeLayout } from "./provider/Drivers/CodexHomeLayout.ts";
import { resolveCodexLaunchArgs } from "./provider/codexLaunchArgs.ts";
import { normalizeOpenCodexBaseUrl } from "./provider/OpenCodexRoute.ts";
import { ServerSettingsService } from "./serverSettings.ts";

const decodeCodexSettings = Schema.decodeEffect(CodexSettings);
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeTranscription = Schema.decodeEffect(Schema.fromJsonString(VoiceTranscriptionInput));
const decodePrewarm = Schema.decodeEffect(Schema.fromJsonString(VoicePrewarmInput));
const isUpstreamError = Schema.is(VoiceTranscriptionUpstreamError);
const isForbiddenError = Schema.is(EnvironmentHttpForbiddenError);
const forbidden = (message: string) => new EnvironmentHttpForbiddenError({ message });

const upstreamError = (code: VoiceTranscriptionErrorCode = "upstream-failed", retryable = true) =>
  new VoiceTranscriptionUpstreamError({
    code,
    retryable,
    message:
      code === "upstream-auth-expired"
        ? "The selected voice account rejected its credentials. Sign in again."
        : "Voice transcription could not be completed.",
  });
const invalidAudio = () =>
  new VoiceTranscriptionBadRequestError({
    code: "invalid-audio",
    message: "Expected a valid 24 kHz mono PCM16 WAV and matching duration.",
  });

/** Credentials remain attached to one selected instance for the entire request. */
interface VoiceSession {
  readonly settings: CodexSettings;
  readonly token: (
    refresh: boolean,
  ) => Effect.Effect<string, VoiceTranscriptionUpstreamError, Scope.Scope>;
}
export class VoiceSessions extends Context.Service<
  VoiceSessions,
  {
    readonly resolve: (
      input: VoicePrewarmInput,
    ) => Effect.Effect<
      VoiceSession,
      VoiceTranscriptionUpstreamError | EnvironmentHttpForbiddenError,
      Scope.Scope
    >;
  }
>()("goat/voiceTranscription/VoiceSessions") {}

export const layerSessions = Layer.effect(
  VoiceSessions,
  Effect.gen(function* () {
    const settingsService = yield* ServerSettingsService;
    const projectionStore = yield* ProjectionStoreV2;
    const projectStore = yield* ProjectStoreV2;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const hostCwd = yield* HostProcess.WorkingDirectory;
    // Capture the environment in which the resolver is constructed, including platform services.
    const services =
      yield* Effect.context<
        Exclude<
          | Effect.Services<ReturnType<typeof makeCodexChatGptAuth>>
          | Effect.Services<ReturnType<typeof withCodexAppServerClient>>
          | Path.Path,
          Scope.Scope
        >
      >();
    return VoiceSessions.of({
      resolve: Effect.fn("VoiceSessions.resolve")(
        function* (input: VoicePrewarmInput) {
          const thread = input.threadId
            ? yield* projectionStore.getThread(input.threadId).pipe(
                Effect.filterOrFail(
                  (row) => row.deletedAt === null,
                  () => forbidden("The requested thread is not accessible."),
                ),
                Effect.mapError(() => forbidden("The requested thread is not accessible.")),
              )
            : undefined;
          const allowedRoots: string[] = [];
          if (thread) {
            const project = yield* projectStore
              .get(thread.projectId)
              .pipe(Effect.mapError(() => forbidden("The requested thread is not accessible.")));
            if (Option.isNone(project))
              return yield* forbidden("The requested thread is not accessible.");
            allowedRoots.push(project.value.workspaceRoot);
            if (thread.worktreePath) allowedRoots.push(thread.worktreePath);
          } else if (input.cwd !== undefined) {
            const shells = yield* projectStore
              .listShells()
              .pipe(
                Effect.mapError(() => forbidden("The requested working directory is invalid.")),
              );
            for (const shell of shells) allowedRoots.push(shell.workspaceRoot);
          }
          const defaultThreadDir = thread?.worktreePath ?? allowedRoots[0];
          const requestedCwd = input.cwd;
          const resolvedCwd =
            requestedCwd === undefined
              ? yield* defaultThreadDir
                  ? fs.realPath(defaultThreadDir).pipe(Effect.orElseSucceed(() => hostCwd))
                  : Effect.succeed(hostCwd)
              : yield* Effect.gen(function* () {
                  const rejectCwd = () =>
                    forbidden("The requested working directory is outside authorized workspaces.");
                  const candidate = yield* fs
                    .realPath(requestedCwd)
                    .pipe(Effect.mapError(rejectCwd));
                  const stat = yield* fs.stat(candidate).pipe(Effect.mapError(rejectCwd));
                  if (stat.type !== "Directory") return yield* rejectCwd();
                  for (const root of allowedRoots) {
                    const realRoot = yield* fs
                      .realPath(root)
                      .pipe(Effect.orElseSucceed(() => undefined));
                    if (
                      realRoot &&
                      (candidate === realRoot ||
                        candidate.startsWith(
                          realRoot.endsWith(path.sep) ? realRoot : `${realRoot}${path.sep}`,
                        ))
                    )
                      return candidate;
                  }
                  return yield* rejectCwd();
                });
          const settings = yield* settingsService.getSettings;
          const requestedId = input.providerInstanceId ?? thread?.modelSelection.instanceId;
          const requestedEntry = requestedId ? settings.providerInstances[requestedId] : undefined;
          if (
            input.providerInstanceId !== undefined &&
            (!requestedEntry ||
              (requestedEntry.driver === "codex" && requestedEntry.enabled === false))
          )
            return yield* upstreamError("voice-backend-unavailable", false);
          const preferred = settings.defaultModelSelection?.instanceId;
          const fallbackCodexId =
            preferred &&
            settings.providerInstances[preferred]?.driver === "codex" &&
            settings.providerInstances[preferred]?.enabled !== false
              ? preferred
              : settings.providerInstances[ProviderInstanceId.make("codex")]?.driver === "codex" &&
                  settings.providerInstances[ProviderInstanceId.make("codex")]?.enabled !== false
                ? ProviderInstanceId.make("codex")
                : (Object.entries(settings.providerInstances).find(
                    ([, candidate]) => candidate.driver === "codex" && candidate.enabled !== false,
                  )?.[0] as ProviderInstanceId | undefined);
          const instanceId =
            requestedEntry?.driver === "codex" && requestedEntry.enabled !== false
              ? requestedId
              : fallbackCodexId;
          const entry = instanceId ? settings.providerInstances[instanceId] : undefined;
          if (!entry || entry.driver !== "codex" || entry.enabled === false || !instanceId)
            return yield* upstreamError("voice-backend-unavailable", false);
          const config = yield* decodeCodexSettings(entry.config ?? {});
          if (!config.enabled) return yield* upstreamError("voice-backend-unavailable", false);
          if (config.setupMode === "managed") {
            const auth = yield* makeCodexChatGptAuth({ instanceId });
            let rejected: Effect.Success<typeof auth.access> | undefined;
            return {
              settings: config,
              token: (refresh: boolean) =>
                (refresh ? auth.refreshAccess(rejected) : auth.access).pipe(
                  Effect.tap((record) =>
                    Effect.sync(() => {
                      rejected = record;
                    }),
                  ),
                  Effect.map((record) => record.accessToken),
                  Effect.mapError(() => upstreamError("upstream-auth-expired", false)),
                ),
            };
          }
          const environment = yield* mergeProviderInstanceEnvironment(entry.environment);
          const layout = yield* resolveCodexHomeLayout(config);
          // Spawn lazily: a working OpenCodex route needs no ChatGPT process.
          let connection: Effect.Success<ReturnType<typeof withCodexAppServerClient>> | undefined;
          const token = Effect.fn("voice.session.token")(
            function* (refresh: boolean) {
              connection ??= yield* withCodexAppServerClient({
                binaryPath: config.binaryPath,
                homePath:
                  layout.effectiveHomePath ?? environment.CODEX_HOME ?? layout.sharedHomePath,
                launchArgs: resolveCodexLaunchArgs(config.launchArgs, environment),
                cwd: resolvedCwd,
                environment,
              });
              const result = yield* connection.client.request("getAuthStatus", {
                includeToken: true,
                refreshToken: refresh,
              });
              if (result.authMethod !== "chatgpt" || !result.authToken)
                return yield* upstreamError("voice-backend-unavailable", false);
              return result.authToken;
            },
            Effect.mapError(() => upstreamError("upstream-auth-expired", false)),
            Effect.provide(services),
          );
          return { settings: config, token };
        },
        Effect.mapError((error) =>
          isUpstreamError(error) || isForbiddenError(error)
            ? error
            : upstreamError("voice-backend-unavailable", false),
        ),
        Effect.provide(services),
      ),
    });
  }),
);

function boundedText<E, R, E2>(
  stream: Stream.Stream<Uint8Array, E, R>,
  maxBytes: number,
  tooLarge: () => E2,
) {
  return Effect.suspend(() => {
    let bytes = 0;
    return stream.pipe(
      Stream.tap((chunk) => {
        bytes += chunk.byteLength;
        return bytes > maxBytes ? Effect.fail(tooLarge()) : Effect.void;
      }),
      Stream.decodeText(),
      Stream.runFold(
        () => "",
        (text, chunk) => text + chunk,
      ),
    );
  });
}

const readBoundedJsonRequestBody = Effect.fn("voice.readBoundedJsonRequestBody")(function* (
  request: HttpServerRequest.HttpServerRequest,
  maxBytes: number,
) {
  const tooLarge = () =>
    new VoiceTranscriptionPayloadTooLargeError({
      code: "invalid-audio",
      message: "Voice request exceeds its size limit.",
    });
  if (Number(request.headers["content-length"]) > maxBytes) return yield* tooLarge();
  return yield* boundedText(
    request.stream.pipe(Stream.mapError(() => invalidAudio())),
    maxBytes,
    tooLarge,
  );
});

const readBoundedUpstreamJson = Effect.fn("voice.readBoundedUpstreamJson")(function* (
  response: HttpClientResponse.HttpClientResponse,
) {
  if (Number(response.headers["content-length"]) > VOICE_TRANSCRIPTION_MAX_RESPONSE_BYTES)
    return yield* upstreamError();
  const text = yield* boundedText(
    response.stream.pipe(Stream.mapError(() => upstreamError())),
    VOICE_TRANSCRIPTION_MAX_RESPONSE_BYTES,
    upstreamError,
  );
  return yield* decodeJson(text).pipe(Effect.mapError(() => upstreamError()));
});

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const admissionKey = Effect.gen(function* () {
  const env = yield* HostProcess.Environment;
  const explicit = env.GOAT_OPENCODEX_API_KEY?.trim() || env.OPENCODEX_API_AUTH_TOKEN?.trim();
  if (explicit) return explicit;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const filename = path.join(
    env.OPENCODEX_HOME?.trim() || path.join(home, ".opencodex"),
    "config.json",
  );
  const contents = yield* fs
    .readFileString(filename)
    .pipe(
      Effect.catch((error) =>
        error.reason._tag === "NotFound"
          ? Effect.succeed("{}")
          : Effect.fail(upstreamError("voice-backend-unavailable", false)),
      ),
    );
  const config = yield* decodeJson(contents).pipe(
    Effect.map(record),
    Effect.mapError(() => upstreamError("voice-backend-unavailable", false)),
  );
  const now = yield* Clock.currentTimeMillis;
  if (!Array.isArray(config?.apiKeys)) return undefined;
  for (const item of config.apiKeys) {
    const key = record(item);
    if (!key || key.active === false || key.enabled === false || key.revokedAt) continue;
    if (typeof key.key === "string" && key.key.trim()) return key.key.trim();
    const pending = record(key.pendingRotation);
    if (
      typeof pending?.key === "string" &&
      pending.key.trim() &&
      typeof pending.expiresAt === "string" &&
      Date.parse(pending.expiresAt) > now
    )
      return pending.key.trim();
  }
  return undefined;
});

function connectionRefused(error: unknown, depth = 0): boolean {
  const value = record(error);
  return (
    depth < 8 &&
    value !== undefined &&
    (value.code === "ECONNREFUSED" ||
      [value.cause, value.reason, value.error].some((nested) =>
        connectionRefused(nested, depth + 1),
      ))
  );
}

const targetFor = Effect.fn("voice.targetFor")(function* (session: VoiceSession) {
  const env = yield* HostProcess.Environment;
  const configured = env.GOAT_OPENCODEX_BASE_URL?.trim();
  if (!configured && session.settings.modelRoute !== "opencodex") return undefined;
  const baseUrl = yield* Effect.try({
    try: () => normalizeOpenCodexBaseUrl(configured || session.settings.opencodexBaseUrl),
    catch: () => upstreamError("voice-backend-unavailable", false),
  });
  const key = yield* admissionKey;
  return key ? { baseUrl, key } : undefined;
});

const transcribe = Effect.fn("voice.transcribe")(
  function* (session: VoiceSession, input: VoiceTranscriptionInput, bytes: Uint8Array) {
    const http = yield* HttpClient.HttpClient;
    const upload = Effect.fn("voice.upload")(function* (
      url: string,
      token: string,
      openCodex: boolean,
    ) {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(bytes)], { type: "audio/wav" }), "voice.wav");
      if (openCodex) {
        form.append("model", "gpt-4o-transcribe");
        form.append("response_format", "json");
      }
      if (input.locale) form.append("language", input.locale.split(/[-_]/)[0] ?? input.locale);
      if (input.prompt) form.append("prompt", input.prompt);
      const response = yield* HttpClient.withScope(http)
        .execute(
          HttpClientRequest.post(url).pipe(
            HttpClientRequest.setHeader(
              openCodex ? "x-opencodex-api-key" : "authorization",
              openCodex ? token : `Bearer ${token}`,
            ),
            HttpClientRequest.bodyFormData(form),
          ),
        )
        .pipe(
          Effect.provideService(FetchHttpClient.RequestInit, {
            redirect: "manual",
            credentials: "omit",
          }),
        );
      // Authentication is classified before parsing: proxies often return HTML on rejection.
      if (response.status === 401 || response.status === 403) return { rejected: true as const };
      const body = yield* readBoundedUpstreamJson(response);
      if (response.status < 200 || response.status >= 300)
        return yield* upstreamError(
          response.status === 429 ? "upstream-rate-limited" : "upstream-failed",
          response.status === 429 || response.status >= 500,
        );
      const text = record(body)?.text;
      if (typeof text !== "string") return yield* upstreamError();
      return { rejected: false as const, text };
    }, Effect.scoped);
    const target = yield* targetFor(session);
    if (target) {
      const result = yield* upload(`${target.baseUrl}/audio/transcriptions`, target.key, true).pipe(
        Effect.catchIf(connectionRefused, () => Effect.void),
      );
      if (result?.rejected) return yield* upstreamError("upstream-auth-expired", false);
      if (result) return { text: result.text, route: "opencodex" as const };
    }
    let token = yield* session.token(false);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = yield* upload("https://chatgpt.com/backend-api/transcribe", token, false);
      if (!result.rejected) return { text: result.text, route: "chatgpt-session" as const };
      if (attempt === 0) token = yield* session.token(true);
    }
    return yield* upstreamError("upstream-auth-expired", false);
  },
  Effect.mapError((error) => (isUpstreamError(error) ? error : upstreamError())),
  Effect.timeout("120 seconds"),
  Effect.catchTags({ TimeoutError: () => Effect.fail(upstreamError("upstream-timeout")) }),
);

const authorize = Effect.gen(function* () {
  const principal = yield* EnvironmentAuthenticatedPrincipal;
  if (!principal.scopes.has(AuthOrchestrationOperateScope))
    return yield* new EnvironmentHttpForbiddenError({
      message: "Voice input requires orchestration:operate.",
    });
});

export const layerHttp = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "voice",
  Effect.fnUntraced(function* (handlers) {
    const sessions = yield* VoiceSessions;
    const http = yield* HttpClient.HttpClient;
    return handlers
      .handleRaw(
        "transcribe",
        Effect.fn("voice.http.transcribe")(function* ({ request }) {
          yield* authorize;
          const text = yield* readBoundedJsonRequestBody(
            request,
            VOICE_TRANSCRIPTION_MAX_REQUEST_BODY_BYTES,
          );
          const input = yield* decodeTranscription(text).pipe(Effect.mapError(invalidAudio));
          const bytes = base64ToUint8Array(input.audioBase64);
          if (!bytes || !validateCanonicalVoiceWav(bytes, input.durationMs).ok)
            return yield* invalidAudio();
          return yield* Effect.scoped(
            Effect.gen(function* () {
              const session = yield* sessions.resolve(input);
              return yield* transcribe(session, input, bytes).pipe(
                Effect.provideService(HttpClient.HttpClient, http),
              );
            }),
          );
        }),
      )
      .handleRaw(
        "prewarm",
        Effect.fn("voice.http.prewarm")(function* ({ request }) {
          yield* authorize;
          const text = yield* readBoundedJsonRequestBody(
            request,
            VOICE_PREWARM_MAX_REQUEST_BODY_BYTES,
          );
          const input = yield* decodePrewarm(text).pipe(Effect.mapError(invalidAudio));
          return yield* Effect.scoped(
            Effect.gen(function* () {
              const session = yield* sessions.resolve(input);
              if (yield* targetFor(session)) return { ready: true, route: "opencodex" as const };
              yield* session.token(false);
              return { ready: true, route: "chatgpt-session" as const };
            }),
          ).pipe(
            Effect.timeout("10 seconds"),
            Effect.catchTags({
              TimeoutError: () => Effect.fail(upstreamError("upstream-timeout")),
            }),
          );
        }),
      );
  }),
);

export const layer = layerHttp.pipe(Layer.provide(layerSessions));
