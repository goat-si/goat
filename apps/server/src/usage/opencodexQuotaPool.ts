import {
  ClaudeSettings,
  ProviderDriverKind,
  QuotaPool,
  TrimmedNonEmptyString,
  UsageLimitSourceId,
  quotaWindowToAvailability,
  quotaWindowToUsageWindow,
  type ProviderInstanceConfig,
  type QuotaWindow,
  type ServerProvider,
  type UsageLimitSourceSnapshot,
} from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as ByteSize from "effect/ByteSize";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import { mergeProviderInstanceEnvironment } from "@goat/provider-core/server/instanceEnvironment";
import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";

const Config = Schema.Struct({
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  runtimeRole: Schema.optional(Schema.Literals(["standalone", "hub", "client"])),
});
const decodeConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(Config));
const decodePool = Schema.decodeUnknownEffect(QuotaPool);
const decodeHealth = Schema.decodeUnknownEffect(Schema.Struct({ version: TrimmedNonEmptyString }));
const decodeClaude = Schema.decodeUnknownOption(ClaudeSettings);
const decodeDriver = Schema.decodeUnknownOption(ProviderDriverKind);
// The endpoint and the backend switches that send Claude Code somewhere else entirely.
const CLAUDE_ROUTING_ENV = [
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
] as const;
const decodeClaudeRouting = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      env: Schema.optional(
        Schema.Struct({
          ANTHROPIC_BASE_URL: Schema.optional(Schema.String),
          CLAUDE_CODE_USE_BEDROCK: Schema.optional(Schema.String),
          CLAUDE_CODE_USE_VERTEX: Schema.optional(Schema.String),
          CLAUDE_CODE_USE_FOUNDRY: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
);
// Claude Code's own truthiness: anything else leaves the backend off.
const enabledFlag = (value: string | undefined) =>
  value !== undefined && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());

/** An OpenCodex that is installed here: its pool, or why GOAT could not read it. */
export type QuotaPoolSnapshot =
  | {
      readonly origin: string;
      readonly pool: QuotaPool;
      readonly unavailable?: undefined;
      readonly version?: undefined;
    }
  | {
      readonly origin: string;
      readonly pool?: undefined;
      readonly unavailable: string;
      readonly version?: string | undefined;
    };

// The Home base (Codex, and every driver's explicit Home route) ends in /v1; Claude Code takes the origin.
const HOME_PATHS = ["/v1", "/v1/"];
const ORIGIN_PATHS = ["/"];

function matchesOpenCodex(
  value: string | undefined,
  origin: string,
  paths: ReadonlyArray<string>,
): boolean {
  const url = URL.parse(value ?? "");
  return (
    url !== null &&
    url.protocol === "http:" &&
    ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
    url.port === new URL(origin).port &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    paths.includes(url.pathname)
  );
}

const openCodexHomeLabel = (pool: QuotaPool) => `via OpenCodex Home ${pool.producer.homeId}`;

const drivers = { openai: "codex", anthropic: "claudeAgent" } as const;
const poolProviders: Partial<Record<string, keyof typeof drivers>> = {
  codex: "openai",
  claudeAgent: "anthropic",
};
const UNVERIFIED = "The OpenCodex route for this instance is not verified yet.";

const mapped = <A>(
  windows: ReadonlyArray<QuotaWindow>,
  map: (window: QuotaWindow) => A | undefined,
) =>
  windows.flatMap((window) => {
    const value = map(window);
    return value === undefined ? [] : [value];
  });

/** The routed login as its own probe saw it; GOAT-routed Codex cannot redeem on that route. */
function localAccountOf(provider: ServerProvider) {
  const limits = provider.usageLimits;
  if (
    limits === undefined ||
    limits.unavailable !== undefined ||
    limits.quotaPoolRoute !== undefined
  )
    return undefined;
  if (limits.windows.length === 0 && limits.resetCredits === undefined) return undefined;
  return {
    checkedAt: limits.checkedAt,
    windows: limits.windows,
    ...(limits.resetCredits === undefined ? {} : { resetCredits: limits.resetCredits }),
    ...(limits.credentialFingerprint === undefined
      ? {}
      : { credentialFingerprint: limits.credentialFingerprint }),
    redeemable: !(provider.driver === "codex" && provider.codexRoute?.modelRoute === "opencodex"),
  };
}

export function quotaPoolSource(pool: QuotaPool): UsageLimitSourceSnapshot {
  return {
    id: UsageLimitSourceId.make("opencodex"),
    kind: "opencodex",
    label: openCodexHomeLabel(pool),
    checkedAt: pool.generatedAt,
    homeId: pool.producer.homeId,
    accounts: pool.providers.flatMap((provider) =>
      provider.accounts.flatMap((account) => {
        const driver = decodeDriver(
          account.driver ?? drivers[provider.provider as keyof typeof drivers],
        );
        if (Option.isNone(driver)) return [];
        // The oldest reading is how fresh this account's quota is; membership follows generatedAt.
        const observedAt =
          account.windows.map((window) => window.observedAt).toSorted()[0] ?? pool.generatedAt;
        return [
          {
            id: JSON.stringify([pool.producer.homeId, provider.provider, account.accountRef]),
            driver: driver.value,
            ...(account.plan === undefined ? {} : { plan: account.plan }),
            ...(account.label === undefined ? {} : { label: account.label }),
            state: account.state,
            observedAt,
            usageLimits: {
              checkedAt: pool.generatedAt,
              windows: mapped(account.windows, quotaWindowToUsageWindow),
            },
          },
        ];
      }),
    ),
  };
}

export const makeOpenCodexQuotaPool = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const environment = yield* HostProcess.Environment;
  const http = yield* HttpClient.HttpClient;
  const configDir = environment.OPENCODEX_HOME || path.join(home, ".opencodex");

  // HTTP errors retain the request, which carries the admin token. Never log their causes.
  const fetchPool = Effect.fn("OpenCodexQuotaPool.fetchPool")(
    function* (url: string, token: string, relay: boolean) {
      const response = yield* http.execute(
        HttpClientRequest.get(url).pipe(HttpClientRequest.bearerToken(token)),
      );
      if (response.status === 404)
        return relay
          ? "Home's relay has no quota-pool API"
          : "this OpenCodex has no quota-pool API";
      if (response.status !== 200) return `it answered HTTP ${response.status}`;
      return yield* response.json.pipe(
        Effect.flatMap(decodePool),
        Effect.orElseSucceed(() => "its pool response could not be read"),
      );
    },
    Effect.scoped,
    Effect.orElseSucceed(() => "it could not be reached"),
    Effect.timeoutOption("5 seconds"),
    Effect.map(Option.getOrElse(() => "it did not answer within 5 seconds")),
  );

  const readVersion = (origin: string) =>
    http.execute(HttpClientRequest.get(`${origin}/healthz`)).pipe(
      Effect.flatMap((response) => response.json),
      Effect.flatMap(decodeHealth),
      Effect.map((health) => health.version),
      Effect.scoped,
      Effect.orElseSucceed(() => undefined),
      Effect.timeoutOption("2 seconds"),
      Effect.map(Option.getOrUndefined),
    );

  const read = Effect.fn("OpenCodexQuotaPool.read")(
    function* (): Effect.fn.Return<QuotaPoolSnapshot | undefined> {
      const config = yield* fs
        .readFileString(path.join(configDir, "config.json"))
        .pipe(Effect.flatMap(decodeConfig), Effect.option);
      if (Option.isNone(config)) return undefined;
      const origin = `http://127.0.0.1:${config.value.port}`;
      // A Child authenticates to its own management API; only its passive relay reaches Home.
      const relay = config.value.runtimeRole === "client";
      const endpoint = relay ? "/api/machine/hub-relay/api/quota-pool" : "/api/quota-pool";
      const token = yield* fs.readFileString(path.join(configDir, "admin-api-token")).pipe(
        Effect.map((value) => value.trim()),
        Effect.orElseSucceed(() => ""),
      );
      const outcome =
        token.length === 0
          ? "GOAT could not read its admin token"
          : yield* fetchPool(`${origin}${endpoint}`, token, relay);
      if (typeof outcome !== "string") return { origin, pool: outcome };
      const version = yield* readVersion(origin);
      return {
        origin,
        version,
        unavailable:
          "OpenCodex pool unavailable" +
          (version === undefined ? "" : ` (OpenCodex ${version})`) +
          `: ${outcome}.`,
      };
    },
    Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.mebibytes(4)),
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual", credentials: "omit" }),
  );

  /** Where this instance's requests actually go, from what its own probe or launch observed. */
  const routeOf = Effect.fn("OpenCodexQuotaPool.routeOf")(function* (
    provider: ServerProvider,
    instance: ProviderInstanceConfig,
    origin: string,
  ) {
    const poolProvider = poolProviders[provider.driver];
    if (poolProvider === undefined) return undefined;
    const verified = { provider: poolProvider, verified: true } as const;
    const homeBase = provider.homeRoute?.effectiveBaseUrl;
    if (homeBase !== undefined)
      return matchesOpenCodex(homeBase, origin, HOME_PATHS) ? verified : undefined;
    if (provider.driver === "codex") {
      const route = provider.codexRoute;
      // Published only after config/read in the instance's own home and environment.
      if (route?.effectiveBaseUrl !== undefined)
        return matchesOpenCodex(route.effectiveBaseUrl, origin, HOME_PATHS) ? verified : undefined;
      return route?.modelRoute === "opencodex"
        ? ({ provider: poolProvider, verified: false } as const)
        : undefined;
    }
    const env = yield* mergeProviderInstanceEnvironment(instance.environment, environment);
    const config = decodeClaude(instance.config ?? {});
    // Claude Code applies settings-file env over its process environment.
    const fromSettings: Partial<Record<(typeof CLAUDE_ROUTING_ENV)[number], string | undefined>> =
      Option.isNone(config)
        ? {}
        : yield* fs
            .readFileString(
              path.join(yield* resolveClaudeHomePath(config.value, env), "settings.json"),
            )
            .pipe(
              Effect.flatMap(decodeClaudeRouting),
              Effect.map((settings) => settings.env ?? {}),
              Effect.orElseSucceed(() => ({})),
            );
    const effective = Object.fromEntries(
      CLAUDE_ROUTING_ENV.map((name) => [name, fromSettings[name] ?? env[name]]),
    );
    if (
      enabledFlag(effective.CLAUDE_CODE_USE_BEDROCK) ||
      enabledFlag(effective.CLAUDE_CODE_USE_VERTEX) ||
      enabledFlag(effective.CLAUDE_CODE_USE_FOUNDRY)
    )
      return undefined;
    return matchesOpenCodex(effective.ANTHROPIC_BASE_URL, origin, ORIGIN_PATHS)
      ? verified
      : undefined;
  });

  const project = Effect.fn("OpenCodexQuotaPool.project")(
    function* (
      providers: ReadonlyArray<ServerProvider>,
      instances: Readonly<Record<string, ProviderInstanceConfig>>,
      snapshot: QuotaPoolSnapshot | undefined,
    ) {
      if (snapshot === undefined) return providers;
      return yield* Effect.forEach(
        providers,
        Effect.fn("OpenCodexQuotaPool.projectProvider")(function* (provider): Effect.fn.Return<
          ServerProvider,
          never,
          Path.Path
        > {
          // Instances absent from settings are the registry's implicit defaults: just the driver.
          const instance = instances[provider.instanceId] ?? { driver: provider.driver };
          const route = yield* routeOf(provider, instance, snapshot.origin);
          if (route === undefined) return provider;
          const localAccount = localAccountOf(provider);
          const own = localAccount === undefined ? {} : { localAccount };
          if (snapshot.pool === undefined || !route.verified) {
            const version = route.verified ? snapshot.version : undefined;
            return {
              ...provider,
              usageLimits: {
                checkedAt: provider.usageLimits?.checkedAt ?? provider.checkedAt,
                windows: [],
                unavailable: {
                  reason: "probeFailed" as const,
                  message: (route.verified ? snapshot.unavailable : undefined) ?? UNVERIFIED,
                },
                quotaPoolRoute: {
                  provider: route.provider,
                  ...(version === undefined ? {} : { openCodexVersion: version }),
                },
                ...own,
              },
            };
          }
          const { pool } = snapshot;
          const entry = pool.providers.find((item) => item.provider === route.provider);
          const accounts = new Map(entry?.accounts.map((account) => [account.accountRef, account]));
          const availability = mapped(entry?.pooled.windows ?? [], quotaWindowToAvailability);
          return {
            ...provider,
            usageLimits: {
              checkedAt: pool.generatedAt,
              windows: mapped(entry?.pooled.windows ?? [], quotaWindowToUsageWindow),
              ...(availability.length === 0 ? {} : { availability }),
              quotaPool: {
                provider: route.provider,
                homeId: pool.producer.homeId,
                accounts: {
                  available: [...accounts.values()].filter(
                    (account) => account.state === "available",
                  ).length,
                  total: accounts.size,
                },
              },
              quotaPoolRoute: { provider: route.provider },
              ...own,
            },
          };
        }),
      );
    },
    Effect.provideService(Path.Path, path),
  );
  return { read, project };
});
