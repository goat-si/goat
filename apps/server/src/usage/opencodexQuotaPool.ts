import {
  CodexSettings,
  ClaudeSettings,
  ProviderDriverKind,
  QuotaPool,
  UsageLimitSourceId,
  quotaWindowToUsageWindow,
  type ProviderInstanceConfig,
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
const decodeCodex = Schema.decodeUnknownOption(CodexSettings);
const decodeClaude = Schema.decodeUnknownOption(ClaudeSettings);
const decodeDriver = Schema.decodeUnknownOption(ProviderDriverKind);
const decodeClaudeEndpoint = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      env: Schema.optional(Schema.Struct({ ANTHROPIC_BASE_URL: Schema.optional(Schema.String) })),
    }),
  ),
);

function localEndpoint(value: string | undefined, origin: string): boolean {
  const url = URL.parse(value ?? "");
  return (
    url !== null &&
    url.protocol === "http:" &&
    ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
    url.port === new URL(origin).port &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash
  );
}

const openCodexHomeLabel = (pool: QuotaPool) => `via OpenCodex Home ${pool.producer.homeId}`;

const drivers = { openai: "codex", anthropic: "claudeAgent" } as const;

export function quotaPoolSource(pool: QuotaPool): UsageLimitSourceSnapshot {
  return {
    id: UsageLimitSourceId.make("opencodex"),
    kind: "opencodex",
    label: openCodexHomeLabel(pool),
    checkedAt: pool.generatedAt,
    accounts: pool.providers.flatMap((provider) =>
      provider.accounts.flatMap((account) => {
        const driver = decodeDriver(
          account.driver ?? drivers[provider.provider as keyof typeof drivers],
        );
        if (Option.isNone(driver)) return [];
        return [
          {
            id: `${provider.provider}:${account.accountRef}`,
            driver: driver.value,
            ...(account.plan === undefined ? {} : { plan: account.plan }),
            usageLimits: {
              checkedAt: pool.generatedAt,
              windows: account.windows.flatMap((window) => {
                const mapped = quotaWindowToUsageWindow(window);
                return mapped === undefined ? [] : [mapped];
              }),
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

  const read = Effect.fn("OpenCodexQuotaPool.read")(
    function* () {
      const config = yield* fs
        .readFileString(path.join(configDir, "config.json"))
        .pipe(Effect.flatMap(decodeConfig));
      const origin = `http://127.0.0.1:${config.port}`;
      // A Child authenticates to its own management API; only its passive relay reaches Home.
      const endpoint =
        config.runtimeRole === "client"
          ? "/api/machine/hub-relay/api/quota-pool"
          : "/api/quota-pool";
      const token = (yield* fs.readFileString(path.join(configDir, "admin-api-token"))).trim();
      if (token.length === 0) return undefined;
      const response = yield* http.execute(
        HttpClientRequest.get(`${origin}${endpoint}`).pipe(HttpClientRequest.bearerToken(token)),
      );
      // OCX-1 is optional during rollout, including on older Children/Home pairs.
      if (response.status === 404) return undefined;
      if (response.status !== 200) return undefined;
      const pool = yield* response.json.pipe(Effect.flatMap(decodePool));
      return { pool, origin };
    },
    Effect.scoped,
    Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.mebibytes(4)),
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual", credentials: "omit" }),
    Effect.timeout("5 seconds"),
    // HTTP errors retain the request, which carries the admin token. Never log their causes.
    Effect.orElseSucceed(() => undefined),
  );

  const project = Effect.fn("OpenCodexQuotaPool.project")(
    function* (
      providers: ReadonlyArray<ServerProvider>,
      instances: Readonly<Record<string, ProviderInstanceConfig>>,
      snapshot: { readonly pool: QuotaPool; readonly origin: string } | undefined,
    ) {
      if (snapshot === undefined) return providers;
      const { pool, origin } = snapshot;
      return yield* Effect.forEach(
        providers,
        Effect.fn("OpenCodexQuotaPool.projectProvider")(function* (provider) {
          const instance = instances[provider.instanceId];
          if (instance === undefined) return provider;
          let poolProvider: string | undefined;
          if (instance.driver === "codex") {
            const config = decodeCodex(instance.config ?? {});
            if (Option.isSome(config) && config.value.modelRoute === "opencodex") {
              if (localEndpoint(config.value.opencodexBaseUrl, origin)) poolProvider = "openai";
            }
          } else if (instance.driver === "claudeAgent") {
            const env = yield* mergeProviderInstanceEnvironment(instance.environment, environment);
            let value = env.ANTHROPIC_BASE_URL;
            const config = decodeClaude(instance.config ?? {});
            if (value === undefined && Option.isSome(config)) {
              const dir = yield* resolveClaudeHomePath(config.value, env);
              value = yield* fs.readFileString(path.join(dir, "settings.json")).pipe(
                Effect.flatMap(decodeClaudeEndpoint),
                Effect.map((settings) => settings.env?.ANTHROPIC_BASE_URL),
                Effect.orElseSucceed(() => undefined),
              );
            }
            if (localEndpoint(value, origin)) poolProvider = "anthropic";
          }
          if (poolProvider === undefined) return provider;
          const pooled = pool.providers.find((entry) => entry.provider === poolProvider);
          return {
            ...provider,
            usageLimits: {
              checkedAt: pool.generatedAt,
              windows: (pooled?.pooled.windows ?? []).flatMap((window) => {
                const mapped = quotaWindowToUsageWindow(window);
                return mapped === undefined ? [] : [mapped];
              }),
              quotaPool: { provider: poolProvider, homeId: pool.producer.homeId },
            },
          };
        }),
      );
    },
    Effect.provideService(Path.Path, path),
  );
  return { read, project };
});
