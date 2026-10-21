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
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";
import { makeOpenCodexQuotaPool, quotaPoolSource } from "./opencodexQuotaPool.ts";
import payload from "./fixtures/opencodex-quota-pool.json" with { type: "json" };

// OCX-1 is not deployed yet. This sanitized wire fixture follows approved design §3.2.
const pool = Schema.decodeUnknownSync(QuotaPool)(payload);
const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claudeAgent");
const native = (driver = "codex"): ServerProvider => ({
  instanceId: ProviderInstanceId.make(driver),
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
  },
});

const fixture = (
  options: {
    role?: "hub" | "client";
    response?: () => Response;
    claudeEndpoint?: string;
    token?: string;
  } = {},
) => {
  const requests: Array<{ url: string; authorization: string | undefined; method: string }> = [];
  const reads: string[] = [];
  const fs = FileSystem.makeNoop({
    readFileString: (filename) =>
      Effect.sync(() => {
        reads.push(filename);
        if (filename === "/fixture-ocx/config.json")
          return JSON.stringify({ port: 10100, runtimeRole: options.role ?? "hub" });
        if (filename === "/fixture-ocx/admin-api-token") return options.token ?? "fixture-token";
        if (filename === "/fixture-user/.claude/settings.json")
          return JSON.stringify({ env: { ANTHROPIC_BASE_URL: options.claudeEndpoint } });
        throw new Error("Unexpected fixture read");
      }),
  });
  const layer = Layer.mergeAll(
    Layer.succeed(FileSystem.FileSystem, fs),
    Path.layer,
    Layer.succeed(HostProcess.HomeDirectory, "/fixture-user"),
    Layer.succeed(HostProcess.Environment, { OPENCODEX_HOME: "/fixture-ocx" }),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          requests.push({
            url: request.url,
            authorization: request.headers.authorization,
            method: request.method,
          });
          return HttpClientResponse.fromWeb(
            request,
            options.response?.() ?? Response.json(payload),
          );
        }),
      ),
    ),
  );
  return { layer, requests, reads };
};

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
    const source = quotaPoolSource(result!.pool);
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

it.effect.each([404, 401, 503, 302])(
  "keeps native quota when OpenCodex answers HTTP %s",
  (status) => {
    const f = fixture({ response: () => new Response("unavailable", { status }) });
    return Effect.gen(function* () {
      const reader = yield* makeOpenCodexQuotaPool;
      const result = yield* reader.read();
      expect(result).toBeUndefined();
      const providers = [native()];
      expect(yield* reader.project(providers, {}, result)).toBe(providers);
      expect(f.requests).toHaveLength(1);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect("ignores malformed responses and never probes without a token", () => {
  const f = fixture({ response: () => Response.json({ schema: "ocx.quota-pool/2" }) });
  const noToken = fixture({ token: "" });
  return Effect.gen(function* () {
    const reader = yield* makeOpenCodexQuotaPool.pipe(Effect.provide(f.layer));
    expect(yield* reader.read()).toBeUndefined();
    const disabled = yield* makeOpenCodexQuotaPool.pipe(Effect.provide(noToken.layer));
    expect(yield* disabled.read()).toBeUndefined();
    expect(noToken.requests).toEqual([]);
  });
});

it.effect(
  "publishes the pool and labels routed Codex/Claude reports without local account quota",
  () => {
    let unsupported = false;
    let responsePayload = pool;
    const responses = fixture({
      response: () =>
        unsupported ? new Response(null, { status: 404 }) : Response.json(responsePayload),
      claudeEndpoint: "http://localhost:10100",
    });
    return Effect.gen(function* () {
      const sources = yield* UsageLimitSources.make;
      yield* sources.refresh;
      expect(yield* sources.quotaPool).toEqual(pool);
      expect((yield* sources.current)[0]?.kind).toBe("opencodex");
      const original = [native(), native("claudeAgent")];
      const projected = yield* sources.projectProviders(original);
      expect(
        projected[0]?.usageLimits?.windows.map((window) => [window.id, window.usedPercent]),
      ).toEqual([
        ["5h", 61],
        ["weekly", 32],
      ]);
      expect(projected[0]?.usageLimits?.quotaPool).toEqual({
        provider: "openai",
        homeId: "fixture-home",
      });
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
      expect(yield* sources.projectProviders(original)).toBe(original);
    }).pipe(
      Effect.provide([
        responses.layer,
        NodeCrypto.layer,
        ServerSettings.layerTest({
          providerInstances: {
            [codex]: {
              driver: ProviderDriverKind.make("codex"),
              config: { modelRoute: "opencodex", opencodexBaseUrl: "http://localhost:10100/v1" },
            },
            [claude]: { driver: ProviderDriverKind.make("claudeAgent") },
          },
        }),
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
    const projected = yield* reader.project(
      [native()],
      {
        [codex]: { driver: ProviderDriverKind.make("codex"), config: { modelRoute: "opencodex" } },
      },
      snapshot,
    );
    expect(projected[0]?.usageLimits?.windows).toEqual([]);
    expect(projected[0]?.usageLimits?.quotaPool).toEqual({
      provider: "openai",
      homeId: "fixture-home",
    });
  }).pipe(Effect.provide(f.layer));
});

it.effect("leaves direct and differently routed instances on their own limits", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const reader = yield* makeOpenCodexQuotaPool;
    const snapshot = yield* reader.read();
    const providers = [native(), native("claudeAgent")];
    const projected = yield* reader.project(
      providers,
      {
        [codex]: { driver: ProviderDriverKind.make("codex"), config: { modelRoute: "default" } },
        [claude]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          environment: [
            { name: "ANTHROPIC_BASE_URL", value: "http://127.0.0.1:20200", sensitive: false },
          ],
        },
      },
      snapshot,
    );
    expect(projected).toEqual(providers);
  }).pipe(Effect.provide(f.layer));
});
