import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  QuotaPool,
  type ServerProvider,
} from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import { collectProviderUsageLimits } from "@goat/shared/usageLimits";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as TestClock from "effect/testing/TestClock";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";
import { makeOpenCodexQuotaPool, quotaPoolSource } from "./opencodexQuotaPool.ts";
import payload from "./fixtures/opencodex-quota-pool.json" with { type: "json" };

// OCX-1 is not deployed yet. This sanitized wire fixture follows approved design §3.2.
const pool = Schema.decodeUnknownSync(QuotaPool)(payload);
const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claudeAgent");
const LOCAL_CODEX = "http://127.0.0.1:10100/v1";
const native = (
  driver = "codex",
  extra: Partial<ServerProvider> = {},
  instanceId: string = driver,
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated", email: "local@example.test", label: "Pro" },
  checkedAt: pool.generatedAt,
  models: [],
  slashCommands: [],
  skills: [],
  usageLimits: {
    checkedAt: pool.generatedAt,
    windows: [{ id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 88 }],
    resetCredits: { availableCount: 1, nextCreditId: "credit-1" },
  },
  ...extra,
});
const routedCodex = (effectiveBaseUrl = LOCAL_CODEX, instanceId = "codex") =>
  native("codex", { codexRoute: { modelRoute: "default", effectiveBaseUrl } }, instanceId);

const missing = (filename: string) =>
  PlatformError.systemError({
    _tag: "NotFound",
    module: "FileSystem",
    method: "readFileString",
    pathOrDescriptor: filename,
  });

const fixture = (
  options: {
    role?: "hub" | "client";
    response?: () => Response | undefined;
    files?: Record<string, string>;
    token?: string;
    config?: boolean;
    environment?: Record<string, string>;
  } = {},
) => {
  const requests: Array<{ url: string; authorization: string | undefined; method: string }> = [];
  const reads: string[] = [];
  const files: Record<string, string> = {
    ...(options.config === false
      ? {}
      : {
          "/fixture-ocx/config.json": JSON.stringify({
            port: 10100,
            runtimeRole: options.role ?? "hub",
          }),
        }),
    ...(options.token === undefined ? { "/fixture-ocx/admin-api-token": "fixture-token" } : {}),
    ...(options.token ? { "/fixture-ocx/admin-api-token": options.token } : {}),
    ...options.files,
  };
  const fs = FileSystem.makeNoop({
    readFileString: (filename) =>
      Effect.suspend(() => {
        reads.push(filename);
        const text = files[filename];
        return text === undefined ? Effect.fail(missing(filename)) : Effect.succeed(text);
      }),
  });
  const layer = Layer.mergeAll(
    Layer.succeed(FileSystem.FileSystem, fs),
    Path.layer,
    Layer.succeed(HostProcess.HomeDirectory, "/fixture-user"),
    Layer.succeed(HostProcess.Environment, {
      OPENCODEX_HOME: "/fixture-ocx",
      ...options.environment,
    }),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.suspend(() => {
          requests.push({
            url: request.url,
            authorization: request.headers.authorization,
            method: request.method,
          });
          if (request.url.endsWith("/healthz")) {
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json({ service: "opencodex", version: "2.86.0", pid: 1, port: 10100 }),
              ),
            );
          }
          const response = options.response ? options.response() : Response.json(payload);
          return response === undefined
            ? Effect.never
            : Effect.succeed(HttpClientResponse.fromWeb(request, response));
        }),
      ),
    ),
  );
  return { layer, requests, reads };
};

const windowsOf = (provider: ServerProvider | undefined) =>
  provider?.usageLimits?.windows.map((window) => [window.id, window.usedPercent]);

it.effect("reads Home quota passively with the local admin token and maps known readings", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const reader = yield* makeOpenCodexQuotaPool;
    const result = yield* reader.read();
    expect(result?.pool).toEqual(pool);
    expect(f.requests).toEqual([
      {
        method: "GET",
        url: "http://127.0.0.1:10100/api/quota-pool",
        authorization: "Bearer fixture-token",
      },
    ]);
    expect(f.reads).toEqual(["/fixture-ocx/config.json", "/fixture-ocx/admin-api-token"]);
    const source = quotaPoolSource(result!.pool!);
    expect(source.kind).toBe("opencodex");
    expect(
      source.accounts[0]?.usageLimits.windows.map((window) => [window.kind, window.usedPercent]),
    ).toEqual([
      ["session", 95],
      ["weekly", 30],
    ]);
    expect(source.accounts[1]?.usageLimits.windows).toEqual([]);
    expect(JSON.stringify(source)).not.toContain("fixture-token");
  }).pipe(Effect.provide(f.layer));
});

it.effect("uses the Child's authenticated read-only management relay", () => {
  const f = fixture({ role: "client" });
  return Effect.gen(function* () {
    const reader = yield* makeOpenCodexQuotaPool;
    expect((yield* reader.read())?.pool).toEqual(pool);
    expect(f.requests).toEqual([
      {
        method: "GET",
        url: "http://127.0.0.1:10100/api/machine/hub-relay/api/quota-pool",
        authorization: "Bearer fixture-token",
      },
    ]);
  }).pipe(Effect.provide(f.layer));
});

it.effect("does nothing on a machine without OpenCodex", () => {
  const f = fixture({ config: false });
  return Effect.gen(function* () {
    const reader = yield* makeOpenCodexQuotaPool;
    const result = yield* reader.read();
    expect(result).toBeUndefined();
    const providers = [routedCodex()];
    expect(yield* reader.project(providers, {}, result)).toBe(providers);
    expect(f.requests).toEqual([]);
  }).pipe(Effect.provide(f.layer));
});

it.effect.each([404, 401, 503, 302])(
  "shows a routed instance's pool as unavailable, never its own login, when OpenCodex answers HTTP %s",
  (status) => {
    const f = fixture({ response: () => new Response("unavailable", { status }) });
    return Effect.gen(function* () {
      const reader = yield* makeOpenCodexQuotaPool;
      const result = yield* reader.read();
      expect(result?.pool).toBeUndefined();
      const direct = native("codex", {}, "direct");
      const [routed, kept] = yield* reader.project([routedCodex(), direct], {}, result);
      expect(routed?.usageLimits?.windows).toEqual([]);
      expect(routed?.usageLimits?.resetCredits).toBeUndefined();
      expect(routed?.usageLimits?.quotaPoolRoute).toEqual({
        provider: "openai",
        openCodexVersion: "2.86.0",
      });
      expect(routed?.usageLimits?.unavailable?.reason).toBe("probeFailed");
      expect(routed?.usageLimits?.unavailable?.message).toContain(
        "OpenCodex pool unavailable (OpenCodex 2.86.0)",
      );
      expect(kept).toBe(direct);
      // The version probe never carries the admin token.
      expect(f.requests.map((request) => [request.url, request.authorization])).toEqual([
        ["http://127.0.0.1:10100/api/quota-pool", "Bearer fixture-token"],
        ["http://127.0.0.1:10100/healthz", undefined],
      ]);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect("treats a quota-pool read that never answers as unavailable", () => {
  const f = fixture({ response: () => undefined });
  return Effect.gen(function* () {
    const reader = yield* makeOpenCodexQuotaPool;
    const fiber = yield* reader.read().pipe(Effect.forkChild);
    yield* TestClock.adjust("6 seconds");
    const result = yield* Fiber.join(fiber);
    const [routed] = yield* reader.project([routedCodex()], {}, result);
    expect(routed?.usageLimits?.windows).toEqual([]);
    expect(routed?.usageLimits?.unavailable?.message).toContain(
      "OpenCodex pool unavailable (OpenCodex 2.86.0)",
    );
  }).pipe(Effect.provide(f.layer));
});

it.effect("treats a malformed pool or a missing admin token as unavailable", () => {
  const malformed = fixture({ response: () => Response.json({ schema: "ocx.quota-pool/2" }) });
  const noToken = fixture({ token: "" });
  return Effect.gen(function* () {
    for (const f of [malformed, noToken]) {
      const reader = yield* makeOpenCodexQuotaPool.pipe(Effect.provide(f.layer));
      const result = yield* reader.read();
      expect(result?.pool).toBeUndefined();
      const [routed] = yield* reader.project([routedCodex()], {}, result);
      expect(routed?.usageLimits?.unavailable?.message).toContain("OpenCodex pool unavailable");
      expect(routed?.usageLimits?.windows).toEqual([]);
    }
    expect(noToken.requests.some((request) => request.url.endsWith("/api/quota-pool"))).toBe(false);
  });
});

it.effect(
  "projects implicit default Codex and Claude instances onto the pool and labels routed reports",
  () => {
    let unsupported = false;
    let responsePayload = pool;
    const responses = fixture({
      response: () =>
        unsupported ? new Response(null, { status: 404 }) : Response.json(responsePayload),
      files: {
        "/fixture-user/.claude/settings.json": JSON.stringify({
          env: { ANTHROPIC_BASE_URL: "http://localhost:10100" },
        }),
      },
    });
    return Effect.gen(function* () {
      const sources = yield* UsageLimitSources.make;
      yield* sources.refresh;
      expect(yield* sources.quotaPool).toEqual(pool);
      expect((yield* sources.current)[0]?.kind).toBe("opencodex");
      const original = [routedCodex(), native("claudeAgent")];
      const projected = yield* sources.projectProviders(original);
      expect(windowsOf(projected[0])).toEqual([
        ["5h", 61],
        ["weekly", 32],
      ]);
      expect(projected[0]?.usageLimits?.quotaPool).toEqual({
        provider: "openai",
        homeId: "fixture-home",
        accounts: { available: 2, total: 2 },
      });
      expect(projected[0]?.usageLimits?.quotaPoolRoute).toEqual({ provider: "openai" });
      expect(projected[0]?.usageLimits?.resetCredits).toBeUndefined();
      expect(projected[0]?.usageLimits?.externalUsage).toBeUndefined();
      expect(projected[1]?.usageLimits?.windows.map((window) => window.scopeModel)).toEqual([
        undefined,
        "family:opus",
      ]);
      for (const instanceId of [codex, claude]) {
        const report = collectProviderUsageLimits(
          instanceId,
          projected,
          [],
          Date.parse(pool.generatedAt),
        );
        expect(report?.accounts[0]?.sourceLabel).toBe("via OpenCodex Home fixture-home");
        expect(report?.accounts[0]?.email).toBeUndefined();
        expect(report?.accounts[0]?.resetCreditInput).toBeUndefined();
      }
      const pull = yield* Stream.toPull(sources.streamChanges);
      const initial = yield* pull;
      responsePayload = {
        ...pool,
        providers: pool.providers.map((entry) =>
          entry.provider !== "openai"
            ? entry
            : {
                ...entry,
                pooled: {
                  ...entry.pooled,
                  windows: entry.pooled.windows.map((window) =>
                    window.id === "5h" ? { ...window, usedPercent: 99 } : window,
                  ),
                },
              },
        ),
      };
      yield* sources.refresh;
      // Pooled-only changes must wake provider subscribers even when account projections are identical.
      expect(yield* pull).toEqual(initial);
      expect(
        (yield* sources.projectProviders(original))[0]?.usageLimits?.windows[0]?.usedPercent,
      ).toBe(99);
      unsupported = true;
      yield* sources.refresh;
      expect(yield* sources.quotaPool).toBeUndefined();
      expect(yield* sources.current).toEqual([]);
      const unavailable = yield* sources.projectProviders(original);
      for (const provider of unavailable) {
        expect(provider.usageLimits?.windows).toEqual([]);
        expect(provider.usageLimits?.unavailable?.message).toContain("OpenCodex pool unavailable");
      }
    }).pipe(
      Effect.provide([
        responses.layer,
        NodeCrypto.layer,
        ServerSettings.layerTest({ providerInstances: {} }),
        Layer.mock(BackgroundPolicy.BackgroundPolicy)({
          shouldRunScopeWork: () => Effect.succeed(false),
        }),
      ]),
      Effect.scoped,
    );
  },
);

it.effect("keeps a missing routed provider unknown instead of borrowing the local login", () => {
  const f = fixture({ response: () => Response.json({ ...payload, providers: [] }) });
  return Effect.gen(function* () {
    const reader = yield* makeOpenCodexQuotaPool;
    const snapshot = yield* reader.read();
    const projected = yield* reader.project([routedCodex()], {}, snapshot);
    expect(projected[0]?.usageLimits?.windows).toEqual([]);
    expect(projected[0]?.usageLimits?.quotaPool).toEqual({
      provider: "openai",
      homeId: "fixture-home",
      accounts: { available: 0, total: 0 },
    });
  }).pipe(Effect.provide(f.layer));
});

it.effect.each([
  { scenario: "another port", codexRoute: { effectiveBaseUrl: "http://127.0.0.1:10101/v1" } },
  { scenario: "a remote endpoint", codexRoute: { effectiveBaseUrl: "https://api.openai.com/v1" } },
  { scenario: "another path", codexRoute: { effectiveBaseUrl: "http://127.0.0.1:10100/v2" } },
  {
    scenario: "an unverifiable endpoint (OPENAI_BASE_URL conflict)",
    codexRoute: { reason: "Could not verify the effective Codex endpoint." },
  },
  {
    scenario: "an OpenCodex route observed on another port",
    codexRoute: { modelRoute: "opencodex", effectiveBaseUrl: "http://127.0.0.1:10101/v1" },
  },
  { scenario: "no route observation yet", codexRoute: undefined },
] as const)("keeps Codex native quota when its probe reports $scenario", ({ codexRoute }) => {
  const f = fixture();
  return Effect.gen(function* () {
    const reader = yield* makeOpenCodexQuotaPool;
    const snapshot = yield* reader.read();
    const provider = native(
      "codex",
      codexRoute === undefined ? {} : { codexRoute: { modelRoute: "default", ...codexRoute } },
    );
    expect(yield* reader.project([provider], {}, snapshot)).toEqual([provider]);
  }).pipe(Effect.provide(f.layer));
});

it.effect("marks an unverified OpenCodex Codex route without publishing pool quota", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const reader = yield* makeOpenCodexQuotaPool;
    const snapshot = yield* reader.read();
    const failed = native("codex", {
      codexRoute: { modelRoute: "opencodex", state: "failed", reason: "OpenCodex is down" },
    });
    const { usageLimits: _, ...withoutLimits } = failed;
    const [projected] = yield* reader.project([withoutLimits], {}, snapshot);
    expect(projected?.usageLimits?.windows).toEqual([]);
    expect(projected?.usageLimits?.quotaPool).toBeUndefined();
    expect(projected?.usageLimits?.quotaPoolRoute).toEqual({ provider: "openai" });
    expect(projected?.usageLimits?.unavailable?.reason).toBe("probeFailed");
  }).pipe(Effect.provide(f.layer));
});

const CLAUDE_SETTINGS = "/fixture-user/.claude/settings.json";
const LOCAL_CLAUDE = "http://127.0.0.1:10100";
it.effect.each([
  {
    scenario: "routes through instance env when settings name no endpoint",
    env: LOCAL_CLAUDE,
    routed: true,
  },
  {
    scenario: "lets the settings file override a routed env, as Claude Code does",
    settings: "https://api.anthropic.com",
    env: LOCAL_CLAUDE,
    routed: false,
  },
  {
    scenario: "lets a routed settings file override a direct env",
    settings: LOCAL_CLAUDE,
    env: "https://api.anthropic.com",
    routed: true,
  },
  { scenario: "keeps a /v1 path native", env: LOCAL_CLAUDE + "/v1", routed: false },
  {
    scenario: "reads the separate home named by CLAUDE_CONFIG_DIR",
    configDir: "/fixture-claude-work",
    files: {
      "/fixture-claude-work/settings.json": JSON.stringify({
        env: { ANTHROPIC_BASE_URL: LOCAL_CLAUDE },
      }),
    },
    settings: "https://api.anthropic.com",
    routed: true,
  },
  {
    scenario: "follows GOAT's explicit Home overlay",
    homeRoute: true,
    routed: true,
  },
  {
    scenario: "keeps a Bedrock instance native despite a leftover loopback URL",
    env: LOCAL_CLAUDE,
    bedrock: "1",
    routed: false,
  },
  {
    scenario: "lets a settings file that turns Bedrock off keep the route",
    env: LOCAL_CLAUDE,
    bedrock: "1",
    settingsEnv: { CLAUDE_CODE_USE_BEDROCK: "0" },
    routed: true,
  },
  {
    scenario: "keeps the route when a backend flag holds a value Claude Code does not enable",
    env: LOCAL_CLAUDE,
    bedrock: "disabled",
    routed: true,
  },
] as const)("Claude $scenario", (input) => {
  const f = fixture({
    files: {
      ...("files" in input ? input.files : {}),
      ...("settings" in input
        ? { [CLAUDE_SETTINGS]: JSON.stringify({ env: { ANTHROPIC_BASE_URL: input.settings } }) }
        : {}),
      ...("settingsEnv" in input
        ? { [CLAUDE_SETTINGS]: JSON.stringify({ env: input.settingsEnv }) }
        : {}),
    },
  });
  return Effect.gen(function* () {
    const reader = yield* makeOpenCodexQuotaPool;
    const snapshot = yield* reader.read();
    const environment = [
      ...("env" in input
        ? [{ name: "ANTHROPIC_BASE_URL", value: input.env, sensitive: false }]
        : []),
      ...("configDir" in input
        ? [{ name: "CLAUDE_CONFIG_DIR", value: input.configDir, sensitive: false }]
        : []),
      ...("bedrock" in input
        ? [{ name: "CLAUDE_CODE_USE_BEDROCK", value: input.bedrock, sensitive: false }]
        : []),
    ];
    const provider = native(
      "claudeAgent",
      "homeRoute" in input
        ? { homeRoute: { modelRoute: "opencodex", effectiveBaseUrl: LOCAL_CODEX } }
        : {},
    );
    const [projected] = yield* reader.project(
      [provider],
      environment.length === 0
        ? {}
        : { [claude]: { driver: ProviderDriverKind.make("claudeAgent"), environment } },
      snapshot,
    );
    if (input.routed) {
      expect(projected?.usageLimits?.quotaPool?.provider).toBe("anthropic");
    } else {
      expect(projected).toEqual(provider);
    }
  }).pipe(Effect.provide(f.layer));
});

it.effect(
  "keeps the routed login's own quota and credits beside the pool, redeemable only off GOAT's route",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const reader = yield* makeOpenCodexQuotaPool;
      const snapshot = yield* reader.read();
      const goatRouted = native(
        "codex",
        {
          codexRoute: { modelRoute: "opencodex", effectiveBaseUrl: LOCAL_CODEX },
        },
        "goat-routed",
      );
      const [config, goat] = yield* reader.project([routedCodex(), goatRouted], {}, snapshot);
      expect(config?.usageLimits?.resetCredits).toBeUndefined();
      expect(config?.usageLimits?.localAccount).toEqual({
        checkedAt: pool.generatedAt,
        windows: [{ id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 88 }],
        resetCredits: { availableCount: 1, nextCreditId: "credit-1" },
        redeemable: true,
      });
      expect(goat?.usageLimits?.localAccount?.redeemable).toBe(false);
      const failed = yield* reader.project(
        [routedCodex()],
        {},
        {
          origin: "http://127.0.0.1:10100",
          unavailable: "OpenCodex pool unavailable (OpenCodex 2.86.0): x.",
          version: "2.86.0",
        },
      );
      expect(failed[0]?.usageLimits?.localAccount?.resetCredits?.availableCount).toBe(1);
      expect(failed[0]?.usageLimits?.quotaPoolRoute).toEqual({
        provider: "openai",
        openCodexVersion: "2.86.0",
      });
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect("carries pool-wide availability blocks without inventing a percentage", () => {
  const blocked = {
    ...payload,
    providers: payload.providers.map((entry) =>
      entry.provider !== "anthropic"
        ? entry
        : {
            ...entry,
            pooled: {
              windows: [
                ...entry.pooled.windows,
                {
                  id: "availability:family:opus",
                  kind: "custom",
                  label: "Opus availability",
                  scopeModel: "family:opus",
                  resetsAt: "2026-10-22T00:00:00.000Z",
                  source: "measured",
                  observedAt: "2026-10-21T03:00:00.000Z",
                  exhausted: true,
                },
              ],
            },
          },
    ),
  };
  const f = fixture({
    response: () => Response.json(blocked),
    files: {
      "/fixture-user/.claude/settings.json": JSON.stringify({
        env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:10100" },
      }),
    },
  });
  return Effect.gen(function* () {
    const reader = yield* makeOpenCodexQuotaPool;
    const [projected] = yield* reader.project([native("claudeAgent")], {}, yield* reader.read());
    expect(projected?.usageLimits?.windows.map((window) => window.id)).toEqual([
      "5h",
      "family:opus",
    ]);
    expect(projected?.usageLimits?.availability).toEqual([
      {
        id: "availability:family:opus",
        label: "Opus availability",
        exhausted: true,
        scopeModel: "family:opus",
        resetsAt: "2026-10-22T00:00:00.000Z",
        observedAt: "2026-10-21T03:00:00.000Z",
      },
    ]);
  }).pipe(Effect.provide(f.layer));
});

it("publishes pool accounts keyed by Home with their label, state and observation time", () => {
  const source = quotaPoolSource(pool);
  expect(source.homeId).toBe("fixture-home");
  expect(source.accounts[0]).toMatchObject({
    id: JSON.stringify(["fixture-home", "openai", "sha256:account-a"]),
    label: "a***",
    state: "available",
    observedAt: "2026-10-21T03:00:00.000Z",
  });
  expect(source.accounts[1]?.observedAt).toBe(pool.generatedAt);
});
