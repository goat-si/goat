import {
  WS_METHODS,
  type EnvironmentId,
  type ServerConfig,
  type ServerConfigStreamEvent,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { safeErrorLogAttributes } from "../errors/safeLog.ts";
import * as Persistence from "../platform/persistence.ts";
import { subscribe } from "../rpc/client.ts";
import { runCachePersistence } from "./cachePersistence.ts";
import { followStreamInEnvironment } from "./runtime.ts";
import {
  applyServerConfigProjection,
  type ServerConfigProjection,
  withoutEnvironmentThemes,
} from "./serverConfigProjection.ts";

import { type FetchedMachineCatalog, withFetchedMachineCatalogs } from "./serverProviderCatalog.ts";

const cachedConfigSnapshotEvent = (config: ServerConfig): ServerConfigStreamEvent => ({
  version: 1,
  type: "snapshot",
  config,
});

export interface ServerConfigSubscriptionOptions {
  readonly environmentThemes?: boolean;
  readonly usageLimitSources?: boolean;
  readonly usageLimitsCommand?: boolean;
  readonly providerCatalogsOnDemand?: boolean;
  readonly providerCatalogDigests?: boolean;
}

// Configs are JSON-shaped. Missing and undefined object fields persist identically.
function sameCacheValue(previous: unknown, next: unknown): boolean {
  if (previous === next) return true;
  if (
    previous === null ||
    next === null ||
    typeof previous !== "object" ||
    typeof next !== "object"
  ) {
    return false;
  }
  if (Array.isArray(previous) || Array.isArray(next)) {
    if (!Array.isArray(previous) || !Array.isArray(next) || previous.length !== next.length) {
      return false;
    }
    for (let index = 0; index < previous.length; index += 1) {
      if (!sameCacheValue(previous[index], next[index])) return false;
    }
    return true;
  }
  if (
    Object.getPrototypeOf(previous) !== Object.prototype ||
    Object.getPrototypeOf(next) !== Object.prototype
  ) {
    return false;
  }
  const before = previous as Record<string, unknown>;
  const after = next as Record<string, unknown>;
  return (
    Object.keys(before).every((key) =>
      sameCacheValue(before[key], Object.hasOwn(after, key) ? after[key] : undefined),
    ) && Object.keys(after).every((key) => Object.hasOwn(before, key) || after[key] === undefined)
  );
}

export const makeEnvironmentServerConfigState = Effect.fn("EnvironmentServerConfigState.make")(
  function* (
    subscription: ServerConfigSubscriptionOptions,
    machineCatalogs: Stream.Stream<ReadonlyArray<FetchedMachineCatalog>> = Stream.empty,
  ) {
    const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
    const cache = yield* Persistence.EnvironmentCacheStore;
    const environmentId = supervisor.target.environmentId;
    const cachedConfig = yield* cache.loadServerConfig(environmentId).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not load cached server configuration.").pipe(
          Effect.annotateLogs({
            environmentId,
            ...safeErrorLogAttributes(error),
          }),
          Effect.as(Option.none<ServerConfig>()),
        ),
      ),
    );
    const state = yield* SubscriptionRef.make<Option.Option<ServerConfigProjection>>(
      Option.map(cachedConfig, (cached) => ({
        config: withoutEnvironmentThemes(cached),
        latestEvent: cachedConfigSnapshotEvent(withoutEnvironmentThemes(cached)),
        source: "cache" as const,
      })),
    );
    const persistence = yield* Queue.sliding<ServerConfig>(1);
    const pendingPersistence = yield* Ref.make<Option.Option<ServerConfig>>(Option.none());
    let lastPersisted: ServerConfig | undefined;

    const persist = Effect.fn("EnvironmentServerConfigState.persist")(function* (
      config: ServerConfig,
    ) {
      // A cached stall would read as a fresh freeze on the next launch, and a cached hold would
      // offer to resume automation before the live server says whether it is still held.
      const {
        environmentThemes: _themes,
        usageLimitSources: _sources,
        lastEventLoopStall: _stall,
        serverTime: _serverTime,
        automationHold: _hold,
        ...cacheable
      } = config;
      if (lastPersisted !== undefined && sameCacheValue(lastPersisted, cacheable)) {
        return true;
      }
      const saved = yield* cache.saveServerConfig(environmentId, cacheable).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          Effect.logWarning("Could not persist cached server configuration.").pipe(
            Effect.annotateLogs({
              environmentId,
              ...safeErrorLogAttributes(error),
            }),
            Effect.as(false),
          ),
        ),
      );
      if (saved) lastPersisted = cacheable;
      return saved;
    });

    const persistPending = Effect.fn("EnvironmentServerConfigState.persistPending")(function* (
      config: ServerConfig,
    ) {
      if (!(yield* persist(config))) {
        return;
      }
      yield* Ref.update(pendingPersistence, (pending) =>
        Option.isSome(pending) && pending.value === config ? Option.none() : pending,
      );
    });

    yield* Effect.addFinalizer(() =>
      Ref.get(pendingPersistence).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (config) => persist(config).pipe(Effect.asVoid),
          }),
        ),
      ),
    );

    yield* runCachePersistence(persistence, persistPending).pipe(Effect.forkScoped);

    type Update = (
      current: Option.Option<ServerConfigProjection>,
    ) => Option.Option<ServerConfigProjection>;
    let fetchedCatalogs: ReadonlyArray<FetchedMachineCatalog> = [];
    const configUpdates = subscribe(WS_METHODS.subscribeServerConfig, {
      ...(subscription.environmentThemes === true ? { environmentThemes: true } : {}),
      ...(subscription.usageLimitSources === true ? { usageLimitSources: true } : {}),
      ...(subscription.usageLimitsCommand === true ? { usageLimitsCommand: true } : {}),
      ...(subscription.providerCatalogsOnDemand === true ? { providerCatalogsOnDemand: true } : {}),
      ...(subscription.providerCatalogDigests === true ? { providerCatalogDigests: true } : {}),
    }).pipe(
      Stream.map(
        (event): Update =>
          (current) =>
            Option.map(applyServerConfigProjection(current, event), (projection) =>
              withFetchedMachineCatalogs(projection, fetchedCatalogs),
            ),
      ),
    );
    const catalogUpdates = machineCatalogs.pipe(
      Stream.map((catalogs): Update => (current) => {
        fetchedCatalogs = catalogs;
        return Option.map(current, (projection) =>
          withFetchedMachineCatalogs(projection, catalogs),
        );
      }),
    );
    yield* Stream.merge(configUpdates, catalogUpdates).pipe(
      Stream.runForEach((update) =>
        Effect.gen(function* () {
          const current = yield* SubscriptionRef.get(state);
          const next = update(current);
          if (Option.isNone(next) || next.value === Option.getOrUndefined(current)) return;
          yield* Ref.set(pendingPersistence, Option.some(next.value.config));
          yield* SubscriptionRef.set(state, next);
          yield* Queue.offer(persistence, next.value.config);
        }),
      ),
      Effect.forkScoped,
    );

    return state;
  },
);

export function serverConfigStateChanges(
  environmentId: EnvironmentId,
  subscription: ServerConfigSubscriptionOptions,
  machineCatalogs: Stream.Stream<ReadonlyArray<FetchedMachineCatalog>> = Stream.empty,
) {
  return followStreamInEnvironment(
    environmentId,
    Stream.unwrap(
      makeEnvironmentServerConfigState(subscription, machineCatalogs).pipe(
        Effect.map((state) =>
          SubscriptionRef.changes(state).pipe(
            Stream.filterMap((projection) =>
              Option.match(projection, {
                onNone: () => Result.failVoid,
                onSome: (value) => Result.succeed(value),
              }),
            ),
          ),
        ),
      ),
    ),
  );
}
