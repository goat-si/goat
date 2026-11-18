import {
  EnvironmentId,
  OrchestrationV2ShellSnapshotJson,
  type OrchestrationV2ShellSnapshot,
  OrchestrationV2ThreadDetailSnapshot,
  OrchestrationV2ThreadProjectionJson,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const ORCHESTRATION_CACHE_SCHEMA_VERSION = 4 as const;
// Older caches may contain human turns that bypassed server history budgets.
export const ORCHESTRATION_THREAD_CACHE_SCHEMA_VERSION = 5 as const;

/**
 * The server snapshot the cached rows descend from. Hub snapshots may have no origin.
 */
export const ShellCacheOrigin = Schema.Struct({
  instanceId: Schema.String,
  serverVersion: Schema.String,
  databaseMigration: Schema.NullOr(Schema.Int),
  omitIdleSubagents: Schema.Boolean,
  omitOlderSettled: Schema.Boolean,
  /** Epoch milliseconds of that snapshot; replay does not renew it. */
  snapshotAt: Schema.Number,
});
export type ShellCacheOrigin = typeof ShellCacheOrigin.Type;

export const StoredOrchestrationShellSnapshot = Schema.Struct({
  schemaVersion: Schema.Literal(ORCHESTRATION_CACHE_SCHEMA_VERSION),
  environmentId: EnvironmentId,
  snapshot: OrchestrationV2ShellSnapshotJson,
  origin: Schema.optionalKey(ShellCacheOrigin),
});

export function makeShellCacheRecord(
  environmentId: EnvironmentId,
  snapshot: OrchestrationV2ShellSnapshot,
  origin?: ShellCacheOrigin,
): typeof StoredOrchestrationShellSnapshot.Type {
  return {
    schemaVersion: ORCHESTRATION_CACHE_SCHEMA_VERSION,
    environmentId,
    snapshot,
    ...(origin === undefined ? {} : { origin }),
  };
}

export function shellFromCacheRecord<T extends object>(stored: {
  readonly snapshot: T;
  readonly origin?: ShellCacheOrigin;
}): T & { readonly origin?: ShellCacheOrigin } {
  return stored.origin === undefined
    ? stored.snapshot
    : { ...stored.snapshot, origin: stored.origin };
}

export const StoredOrchestrationThreadSnapshot = Schema.Struct({
  schemaVersion: Schema.Literal(ORCHESTRATION_THREAD_CACHE_SCHEMA_VERSION),
  environmentId: EnvironmentId,
  threadId: ThreadId,
  snapshot: OrchestrationV2ThreadDetailSnapshot.mapFields((fields) => ({
    ...fields,
    projection: OrchestrationV2ThreadProjectionJson,
  })),
});

export function decodeOrDiscardOrchestrationCache<A, E, R, E2, R2>(
  decode: Effect.Effect<Option.Option<A>, E, R>,
  discard: Effect.Effect<void, E2, R2>,
) {
  return decode.pipe(Effect.catch(() => discard.pipe(Effect.as(Option.none<A>()))));
}
