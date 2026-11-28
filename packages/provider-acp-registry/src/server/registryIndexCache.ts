import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import type {
  AcpRegistryError,
  AcpRegistryIndex,
  ResolvedAcpRegistryDistribution,
} from "./AcpRegistrySupport.ts";
import { compareText } from "./registrySearch.ts";

const encodeUnknownJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export function registryLaunchIdentity(input: {
  readonly version: string | null;
  readonly distribution: ResolvedAcpRegistryDistribution;
  readonly commandOverride?: string;
}): string {
  const envEntries = Object.entries(input.distribution.env).toSorted(([left], [right]) =>
    compareText(left, right),
  );
  return JSON.stringify({
    version: input.version,
    kind: input.distribution.kind,
    ...(input.commandOverride ? { commandOverride: input.commandOverride } : {}),
    ...(input.distribution.packageName ? { packageName: input.distribution.packageName } : {}),
    ...(input.distribution.binaryTarget
      ? {
          archive: input.distribution.binaryTarget.archive,
          cmd: input.distribution.binaryTarget.cmd,
          sha256: input.distribution.binaryTarget.sha256 ?? null,
        }
      : {}),
    args: input.distribution.args,
    env: envEntries,
  });
}

interface RegistryCacheState {
  readonly index: AcpRegistryIndex | undefined;
  // Unset while holding a cold disk cache, after a fallback, or after invalidateIndex.
  readonly fetchedAtMs: number | undefined;
  readonly failedAtMs: number | undefined;
  readonly lastFailure: AcpRegistryError | undefined;
  readonly fetchRevision: number;
  readonly attemptRevision: number;
  readonly invalidationGeneration: number;
}

export const makeAcpRegistryIndexCache = Effect.fn("AcpRegistryCatalog.makeIndexCache")(
  function* (deps: {
    readonly fetchRegistry: () => Effect.Effect<AcpRegistryIndex, AcpRegistryError>;
    readonly readCachedRegistry: Effect.Effect<Option.Option<AcpRegistryIndex>>;
    readonly defaultSearchMaxAgeMs: number;
  }) {
    const registryState = yield* Ref.make<RegistryCacheState>({
      index: undefined,
      fetchedAtMs: undefined,
      failedAtMs: undefined,
      lastFailure: undefined,
      fetchRevision: 0,
      attemptRevision: 0,
      invalidationGeneration: 0,
    });
    const registrySemaphore = yield* Semaphore.make(1);

    const refreshRegistry = Effect.fn("AcpRegistryCatalog.refreshRegistry")(function* (options?: {
      readonly maxAgeMs?: number;
      readonly failureBackoffMs?: number;
      readonly observedFetchRevision?: number;
      readonly observedAttemptRevision?: number;
    }) {
      const initial = yield* Ref.get(registryState);
      const startFetchRevision = options?.observedFetchRevision ?? initial.fetchRevision;
      const startAttemptRevision = options?.observedAttemptRevision ?? initial.attemptRevision;
      const maxAgeMs = options?.maxAgeMs;
      const failureBackoffMs = options?.failureBackoffMs;
      return yield* registrySemaphore.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(registryState);
          const now = yield* Clock.currentTimeMillis;
          if (
            maxAgeMs !== undefined &&
            current.index !== undefined &&
            current.fetchedAtMs !== undefined &&
            now >= current.fetchedAtMs &&
            now - current.fetchedAtMs < maxAgeMs
          ) {
            return { index: current.index, changed: false };
          }
          if (
            current.index !== undefined &&
            (current.fetchRevision !== startFetchRevision ||
              (failureBackoffMs !== undefined && current.attemptRevision !== startAttemptRevision))
          ) {
            return { index: current.index, changed: false };
          }
          if (
            failureBackoffMs !== undefined &&
            current.index === undefined &&
            current.attemptRevision !== startAttemptRevision &&
            current.lastFailure !== undefined
          ) {
            return yield* current.lastFailure;
          }
          if (
            failureBackoffMs !== undefined &&
            current.failedAtMs !== undefined &&
            now >= current.failedAtMs &&
            now - current.failedAtMs < failureBackoffMs
          ) {
            if (current.index !== undefined) return { index: current.index, changed: false };
            if (current.lastFailure !== undefined) return yield* current.lastFailure;
          }

          const startInvalidationGeneration = current.invalidationGeneration;
          const previousIndex = current.index;
          const outcome = yield* deps.fetchRegistry().pipe(
            Effect.map((index) => ({ _tag: "fetched" as const, index })),
            Effect.catch((networkError) =>
              Effect.gen(function* () {
                // Prefer an already-loaded index over disk so a cache-write failure cannot regress it.
                const inMemory = (yield* Ref.get(registryState)).index;
                if (inMemory !== undefined) {
                  return { _tag: "fallback" as const, index: inMemory, error: networkError };
                }
                const cached = yield* deps.readCachedRegistry;
                if (Option.isSome(cached)) {
                  return { _tag: "fallback" as const, index: cached.value, error: networkError };
                }
                return { _tag: "failed" as const, error: networkError };
              }),
            ),
          );
          const completedAt = yield* Clock.currentTimeMillis;
          if (outcome._tag === "fetched") {
            const changed =
              previousIndex !== undefined &&
              encodeUnknownJson(previousIndex) !== encodeUnknownJson(outcome.index);
            yield* Ref.update(registryState, (state) => {
              const invalidatedMidFlight =
                state.invalidationGeneration !== startInvalidationGeneration;
              return {
                ...state,
                index: outcome.index,
                fetchedAtMs: invalidatedMidFlight ? state.fetchedAtMs : completedAt,
                failedAtMs: invalidatedMidFlight ? state.failedAtMs : undefined,
                lastFailure: invalidatedMidFlight ? state.lastFailure : undefined,
                fetchRevision: invalidatedMidFlight ? state.fetchRevision : state.fetchRevision + 1,
                attemptRevision: invalidatedMidFlight
                  ? state.attemptRevision
                  : state.attemptRevision + 1,
              };
            });
            return { index: outcome.index, changed };
          }
          yield* Ref.update(registryState, (state) => {
            const invalidatedMidFlight =
              state.invalidationGeneration !== startInvalidationGeneration;
            return {
              ...state,
              index: state.index ?? (outcome._tag === "fallback" ? outcome.index : undefined),
              fetchedAtMs: invalidatedMidFlight ? state.fetchedAtMs : undefined,
              failedAtMs: invalidatedMidFlight ? state.failedAtMs : completedAt,
              lastFailure: invalidatedMidFlight ? state.lastFailure : outcome.error,
              attemptRevision: invalidatedMidFlight
                ? state.attemptRevision
                : state.attemptRevision + 1,
            };
          });
          if (outcome._tag === "fallback") {
            return { index: outcome.index, changed: false };
          }
          return yield* outcome.error;
        }),
      );
    });

    const recentRegistry = Effect.fn("AcpRegistryCatalog.recentRegistry")(function* (
      maxAgeMs = deps.defaultSearchMaxAgeMs,
      failureBackoffMs?: number,
    ) {
      const current = yield* Ref.get(registryState);
      const now = yield* Clock.currentTimeMillis;
      // A clock moved back makes the stamp untrustworthy, so it counts as stale.
      if (
        current.index !== undefined &&
        current.fetchedAtMs !== undefined &&
        now >= current.fetchedAtMs &&
        now - current.fetchedAtMs < maxAgeMs
      ) {
        return { index: current.index, changed: false };
      }
      if (
        failureBackoffMs !== undefined &&
        current.index !== undefined &&
        current.failedAtMs !== undefined &&
        now >= current.failedAtMs &&
        now - current.failedAtMs < failureBackoffMs
      ) {
        return { index: current.index, changed: false };
      }
      return yield* refreshRegistry({
        maxAgeMs,
        ...(failureBackoffMs === undefined ? {} : { failureBackoffMs }),
        observedFetchRevision: current.fetchRevision,
        observedAttemptRevision: current.attemptRevision,
      });
    });

    const refreshIndex = Effect.fn("AcpRegistryCatalog.refreshIndex")(function* (options?: {
      readonly maxAgeMs?: number;
      readonly failureBackoffMs?: number;
    }) {
      const result =
        options?.maxAgeMs === undefined
          ? yield* refreshRegistry(
              options?.failureBackoffMs === undefined
                ? undefined
                : { failureBackoffMs: options.failureBackoffMs },
            )
          : yield* recentRegistry(options.maxAgeMs, options.failureBackoffMs);
      return result.changed;
    });

    const invalidateIndex = Effect.fn("AcpRegistryCatalog.invalidateIndex")(function* () {
      yield* Ref.update(registryState, (current) => ({
        ...current,
        fetchedAtMs: undefined,
        failedAtMs: undefined,
        lastFailure: undefined,
        invalidationGeneration: current.invalidationGeneration + 1,
      }));
    });

    const loadRegistry = Effect.fn("AcpRegistryCatalog.loadRegistry")(function* () {
      const current = (yield* Ref.get(registryState)).index;
      if (current !== undefined) return current;

      const cached = yield* deps.readCachedRegistry;
      if (Option.isNone(cached)) return (yield* refreshRegistry()).index;
      // Publish without waiting on an in-flight refresh, while letting a completed refresh win.
      return yield* Ref.modify(registryState, (state) =>
        state.index !== undefined
          ? ([state.index, state] as const)
          : ([cached.value, { ...state, index: cached.value }] as const),
      );
    });

    return { refreshRegistry, recentRegistry, refreshIndex, invalidateIndex, loadRegistry };
  },
);
