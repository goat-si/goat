import {
  DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL,
  UsageLimitSourceError,
  type UsageLimitSourceConsumeResetCreditInput,
  type ProviderConsumeResetCreditResult,
  type ServerSettings,
  type SecretReference,
  type UsageLimitSourceConfig,
  type UsageLimitSourceId,
  type UsageLimitSourceSnapshot,
  type QuotaPool,
  type ServerProvider,
} from "@goat/contracts";
import { resolveServerBackgroundActivitySettings } from "@goat/shared/backgroundActivitySettings";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as Settings from "../serverSettings.ts";
import { makeCliproxyApi } from "./cliproxyApi.ts";
import { makeOpenCodexQuotaPool, quotaPoolSource } from "./opencodexQuotaPool.ts";
import { cachedResolveSecret } from "../secrets/secretResolver.ts";

export async function resolveUsageManagementKey(
  settings: ServerSettings,
  config: UsageLimitSourceConfig,
  resolve: (
    providers: ServerSettings["secretProviders"],
    reference: SecretReference,
  ) => Promise<string> = cachedResolveSecret,
) {
  if (config.managementKeyReference == null) return config.managementKey;
  return resolve(settings.secretProviders, config.managementKeyReference);
}

export class UsageLimitSources extends Context.Service<
  UsageLimitSources,
  {
    readonly current: Effect.Effect<ReadonlyArray<UsageLimitSourceSnapshot>>;
    readonly streamChanges: Stream.Stream<ReadonlyArray<UsageLimitSourceSnapshot>>;
    readonly refresh: Effect.Effect<void>;
    readonly quotaPool: Effect.Effect<QuotaPool | undefined>;
    readonly projectProviders: (
      providers: ReadonlyArray<ServerProvider>,
    ) => Effect.Effect<ReadonlyArray<ServerProvider>>;
    readonly consumeResetCredit: (
      input: UsageLimitSourceConsumeResetCreditInput,
    ) => Effect.Effect<ProviderConsumeResetCreditResult, UsageLimitSourceError>;
  }
>()("goat/usage/UsageLimitSources") {}

function sourceLabel(id: string, config: UsageLimitSourceConfig): string {
  if (config.label) return config.label;
  const fallback = id.trim() || "Usage limit source";
  try {
    return new URL(config.url).host || fallback;
  } catch {
    return fallback;
  }
}

/** @public */
export const make = Effect.gen(function* () {
  const api = yield* makeCliproxyApi;
  const opencodex = yield* makeOpenCodexQuotaPool;
  const poolRef = yield* Ref.make<Effect.Success<ReturnType<typeof opencodex.read>>>(undefined);
  const settingsService = yield* Settings.ServerSettingsService;
  const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
  const stateRef = yield* Ref.make<ReadonlyArray<UsageLimitSourceSnapshot>>([]);
  const changes = yield* Effect.acquireRelease(
    PubSub.unbounded<ReadonlyArray<UsageLimitSourceSnapshot>>(),
    PubSub.shutdown,
  );

  const readSource = Effect.fn("UsageLimitSources.readSource")(function* (
    id: UsageLimitSourceId,
    config: UsageLimitSourceConfig,
    settings: ServerSettings,
  ) {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const base = { id, kind: config.kind, label: sourceLabel(id, config), checkedAt } as const;
    const resolved = yield* Effect.tryPromise(() =>
      resolveUsageManagementKey(settings, config),
    ).pipe(Effect.result);
    if (resolved._tag === "Failure") {
      return {
        ...base,
        accounts: [],
        error: "Could not read the management key from its secret provider.",
      };
    }
    const managementKey = resolved.success;
    if (managementKey.length === 0) {
      return { ...base, accounts: [], error: "No management key configured." };
    }
    const accounts = yield* api.readAccounts({ ...config, managementKey }).pipe(Effect.result);
    if (accounts._tag === "Failure") {
      yield* Effect.logDebug("usage limit source read failed", { id, cause: accounts.failure });
      return { ...base, accounts: [], error: accounts.failure.detail };
    }
    return { ...base, accounts: accounts.success };
  });

  const publish = Effect.fn("UsageLimitSources.publish")(function* (
    next: ReadonlyArray<UsageLimitSourceSnapshot>,
    poolChanged = false,
  ) {
    const changed = yield* Ref.modify(stateRef, (previous) =>
      !poolChanged && Equal.equals(previous, next) ? [false, previous] : [true, next],
    );
    if (changed) yield* PubSub.publish(changes, next);
  });

  // Serialize refreshes so slow old-settings reads cannot resurrect removed sources after newer refreshes.
  const refreshLock = yield* Semaphore.make(1);
  const refresh = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.orElseSucceed((): ServerSettings | null => null),
    );
    const entries = Object.entries(settings?.usageLimitSources ?? {}).filter(
      ([, config]) => config.enabled,
    );
    const snapshots =
      settings === null
        ? []
        : yield* Effect.forEach(
            entries,
            ([id, config]) => readSource(id as UsageLimitSourceId, config, settings),
            { concurrency: 4 },
          );
    const pool = yield* opencodex.read();
    const previous = yield* Ref.getAndSet(poolRef, pool);
    yield* publish(
      pool?.pool === undefined ? snapshots : [...snapshots, quotaPoolSource(pool.pool)],
      !Equal.equals(previous, pool),
    );
  }).pipe(refreshLock.withPermits(1), Effect.ignoreCause({ log: true }));

  // Shares the refresh lock so a stale in-flight read cannot overwrite a redemption.
  const consumeResetCredit = Effect.fn("UsageLimitSources.consumeResetCredit")(function* (
    input: UsageLimitSourceConsumeResetCreditInput,
  ) {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError(() => new UsageLimitSourceError({ detail: "Could not read hub settings." })),
    );
    const config = settings.usageLimitSources[input.sourceId];
    if (!config?.enabled) {
      return yield* new UsageLimitSourceError({
        detail: "The usage limit source is missing or disabled.",
      });
    }
    const managementKey = yield* Effect.tryPromise(() =>
      resolveUsageManagementKey(settings, config),
    ).pipe(
      Effect.mapError(
        () =>
          new UsageLimitSourceError({
            detail: "Could not read the management key from its secret provider.",
          }),
      ),
    );
    if (!managementKey)
      return yield* new UsageLimitSourceError({ detail: "No management key configured." });
    const result = yield* api.consume(
      { ...config, managementKey },
      input.accountId,
      input.creditId,
    );
    const snapshot = yield* readSource(input.sourceId, config, settings);
    const previous = yield* Ref.get(stateRef);
    yield* publish(previous.map((source) => (source.id === input.sourceId ? snapshot : source)));
    return result;
  }, refreshLock.withPermits(1));

  yield* settingsService.streamChanges.pipe(
    Stream.map((settings) => [
      settings.usageLimitSources,
      settings.providerInstances,
      settings.secretProviders,
    ]),
    Stream.changes,
    Stream.runForEach(() => refresh),
    Effect.forkScoped,
  );

  const interval = settingsService.getSettings.pipe(
    Effect.map(
      (settings) => resolveServerBackgroundActivitySettings(settings).providerHealthRefreshInterval,
    ),
    Effect.orElseSucceed(() => DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL),
  );
  yield* Effect.forever(
    interval.pipe(
      Effect.flatMap((wait) => Effect.sleep(Duration.isPositive(wait) ? wait : "60 seconds")),
      Effect.andThen(interval),
      Effect.flatMap((current) =>
        Duration.isPositive(current)
          ? backgroundPolicy.shouldRunScopeWork({ type: "provider-status" })
          : Effect.succeed(false),
      ),
      Effect.flatMap((shouldRun) => (shouldRun ? refresh : Effect.void)),
      Effect.ignoreCause({ log: true }),
    ),
  ).pipe(Effect.forkScoped);

  yield* refresh.pipe(Effect.forkScoped);

  return {
    current: Ref.get(stateRef),
    quotaPool: Ref.get(poolRef).pipe(Effect.map((snapshot) => snapshot?.pool)),
    projectProviders: Effect.fn("UsageLimitSources.projectProviders")(function* (providers) {
      const settings = yield* settingsService.getSettings.pipe(Effect.orElseSucceed(() => null));
      // Implicit default instances are absent here; the projection treats them as the registry does.
      return yield* opencodex.project(
        providers,
        settings?.providerInstances ?? {},
        yield* Ref.get(poolRef),
      );
    }),
    consumeResetCredit,
    refresh,
    get streamChanges() {
      return Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          const snapshot = yield* Ref.get(stateRef);
          // The raw pool can change without changing its legacy account projection.
          return Stream.concat(Stream.make(snapshot), Stream.fromSubscription(subscription));
        }),
      );
    },
  } satisfies UsageLimitSources["Service"];
});

export const layer = Layer.effect(UsageLimitSources, make);
