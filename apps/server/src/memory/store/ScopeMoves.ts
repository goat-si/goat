import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import type { CoreReads } from "./CoreReads.ts";
import type { ItemWrites } from "./ItemWrites.ts";
import type { StoreKernel } from "./StoreKernel.ts";
import { handleCodec, identityCodec, scopeCodec, stored, stringArrayCodec } from "./StoreCodecs.ts";
import { Transaction, hashText, sameHeadSet } from "./StoreModel.ts";

export const rewriteMemoryScope = Effect.fn("MemoryStore.rewriteMemoryScope")(function* (
  {
    sql,
    readItem,
    putItem,
  }: Pick<StoreKernel, "sql"> & Pick<CoreReads, "readItem"> & Pick<ItemWrites, "putItem">,
  identity: M.MemoryIdentityRecord,
  watermark: number,
  authoritativeHeads?: readonly M.MemoryRevisionId[],
) {
  yield* Transaction;
  const { memorySpaceId: space, memoryId, scope, scopeVersion } = identity;
  if (scopeVersion === undefined) return;
  const current = yield* readItem(space, memoryId);
  if (current?.item.status === "forgotten") return;
  const rows = yield* stored(
    "memory-scope-identity",
    sql`UPDATE memory_identity_ledger SET identity_json=${yield* identityCodec.encode(identity)}, scope_version=${scopeVersion}
      WHERE space=${space} AND memory_id=${memoryId} AND scope_version<${scopeVersion}
      AND NOT EXISTS (SELECT 1 FROM memory_tombstones WHERE space=${space} AND memory_id=${memoryId})
      RETURNING memory_id`,
  );
  if (rows.length === 0) return;
  yield* stored(
    "memory-scope-revisions",
    sql`UPDATE memory_revisions SET scope_json=${yield* scopeCodec.encode(scope)},scope_move_held=CASE
      WHEN EXISTS (SELECT 1 FROM memory_events e WHERE e.memory_space_id=memory_revisions.space
        AND e.operation_id=memory_revisions.operation_id
        AND (json_extract(e.receipt_json,'$.hubSequence') IS NULL OR json_extract(e.receipt_json,'$.outcome')='rejected'))
      THEN 1 ELSE scope_move_held END
      WHERE space=${space} AND memory_id=${memoryId}`,
  );
  if (!current) return;
  const item = current.item;
  const [index] = yield* stored(
    "memory-scope-index-fence",
    sql<{ ready: number }>`
    SELECT index_state='ready' AND indexed_generation=generation AS ready FROM memory_items
    WHERE space=${space} AND memory_id=${memoryId}`,
  );
  if (authoritativeHeads && !sameHeadSet(current.heads, authoritativeHeads)) {
    yield* putItem(
      {
        memorySpaceId: space,
        memoryId,
        status: "blocked",
        failureCode: "scanner_pending",
        scope,
        pendingSync: false,
        localAvailability: {
          exposure: "held",
          reasons: ["scanner_pending"],
          deferred: [],
          cleanupPending: item.localAvailability.cleanupPending,
        },
      },
      authoritativeHeads,
      watermark,
    );
    return;
  }
  yield* putItem(
    item.status === "active"
      ? { ...item, scope, revision: { ...item.revision, scope } }
      : { ...item, scope },
    current.heads,
    watermark,
  );
  // The FTS row is keyed by item rowid. Its text is unchanged, so rebind the fence to the new scope.
  if (index?.ready && item.status === "active")
    yield* stored(
      "memory-scope-index-rebind",
      sql`
      UPDATE memory_items SET index_state='ready',indexed_generation=generation
      WHERE space=${space} AND memory_id=${memoryId} AND status='active'`,
    );
});

export const retireScopeSnapshots = Effect.fn("MemoryStore.retireScopeSnapshots")(function* (
  sql: StoreKernel["sql"],
  space: M.MemorySpaceId,
) {
  yield* Transaction;
  const [retention] = yield* stored(
    "memory-scope-handles",
    sql<{ handles_json: string }>`
    SELECT handles_json FROM memory_hub_retention WHERE space=${space}`,
  );
  const handles = retention ? yield* handleCodec.decode(retention.handles_json) : [];
  const keys = yield* stringArrayCodec.encode(
    handles.map(({ snapshotToken }) => hashText(snapshotToken)),
  );
  yield* stored(
    "memory-scope-retire-snapshots",
    sql`UPDATE memory_import_keys SET record_json=json_set(record_json,'$.retired',json('true'))
      WHERE space=${space} AND key_kind='hub_checkpoint_token' AND key IN (SELECT value FROM json_each(${keys}))`,
  );
  yield* stored(
    "memory-scope-stale-checkpoint",
    sql`UPDATE memory_hub_retention SET handles_json='[]',checkpoint_id=NULL WHERE space=${space}`,
  );
});
