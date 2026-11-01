import * as M from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type { CoreReads } from "./CoreReads.ts";
import type { HubSnapshotReads } from "./HubSnapshotReads.ts";
import {
  availabilityCodec,
  checkpointCodec,
  compactCodec,
  decodeMemoryId,
  decodeWork,
  deferredCodec,
  headsCodec,
  hubEntryCodec,
  projectionCodec,
  scopeCodec,
  scopeKey,
  stored,
  suppressionCodec,
  suppressionKeyCodec,
  workMetadataCodec,
} from "./StoreCodecs.ts";
import type { StoreKernel } from "./StoreKernel.ts";
import { MemoryWork, hashText, memorySuppressionRecords, strict } from "./StoreModel.ts";

export const makeItemWrites = (
  kernel: Pick<StoreKernel, "emit" | "markRunnable" | "sql">,
  coreReads: Pick<CoreReads, "readItem" | "readPending">,
  hubSnapshotReads: Pick<HubSnapshotReads, "snapshotBytes">,
) => {
  const { emit, markRunnable, sql } = kernel;
  const { readItem, readPending } = coreReads;
  const { snapshotBytes } = hubSnapshotReads;
  const putItem = Effect.fnUntraced(function* (
    item: M.MemoryItem,
    heads: ReadonlyArray<M.MemoryRevisionId>,
    watermark: number,
  ) {
    const previous = yield* readItem(item.memorySpaceId, item.memoryId);
    const pending = yield* readPending(item.memorySpaceId, item.memoryId);
    const held =
      pending && item.status !== "forgotten"
        ? {
            memorySpaceId: item.memorySpaceId,
            memoryId: item.memoryId,
            status: "blocked" as const,
            scope: item.scope,
            failureCode: "forget_pending" as const,
            pendingSync: item.pendingSync,
            localAvailability: {
              ...item.localAvailability,
              exposure: "held" as const,
              reasons: [...new Set([...item.localAvailability.reasons, "forget_pending" as const])],
            },
          }
        : item;
    const scope =
      held.status === "forgotten"
        ? ((previous?.item.status !== "forgotten" ? previous?.item.scope : undefined) ?? {
            kind: "user" as const,
          })
        : held.scope;
    const generation = (previous?.generation ?? 0) + 1;
    const safeProjection =
      held.status === "active" ? (({ payload: _payload, ...rest }) => rest)(held) : held;
    const scannerDeferred =
      held.localAvailability.reasons.includes("scanner_pending") &&
      !held.localAvailability.deferred.some((d) => d.kind === "scanner")
        ? [
            ...held.localAvailability.deferred,
            {
              kind: "scanner" as const,
              state: "pending" as const,
              reason: "scanner_pending" as const,
              revisionId: heads.length === 1 ? heads[0]! : null,
              generation,
              sinceAtUtc: DateTime.formatIso(DateTime.makeUnsafe(0)),
            },
          ]
        : held.localAvailability.deferred;
    const indexDeferred =
      heads.length === 1 &&
      held.status !== "forgotten" &&
      !scannerDeferred.some((d) => d.kind === "index")
        ? [
            ...scannerDeferred,
            {
              kind: "index" as const,
              state: "pending" as const,
              reason: "index_unavailable" as const,
              revisionId: heads[0]!,
              generation,
              sinceAtUtc: DateTime.formatIso(DateTime.makeUnsafe(0)),
            },
          ]
        : scannerDeferred;
    const deferred = indexDeferred.map((d) => ({
      ...d,
      generation,
      attempt: 0,
      dueAt: 0,
      lastAttemptAt: null,
      claimedBy: null,
      claimedUntil: null,
    }));
    yield* stored(
      "projection",
      sql`INSERT INTO memory_items (space,memory_id,scope_json,scope_key,heads_json,status,payload_ref,projection_watermark,item_json,availability_json,generation,deferred_json,cleanup_pending)
      VALUES (${held.memorySpaceId},${held.memoryId},${yield* scopeCodec.encode(scope)},${scopeKey(scope)},${yield* headsCodec.encode(heads)},${held.status},${held.status === "active" ? held.revision.payloadRef : null},${watermark},${yield* projectionCodec.encode(safeProjection)},${yield* availabilityCodec.encode(held.localAvailability)},${generation},${yield* deferredCodec.encode(deferred)},${held.localAvailability.cleanupPending ? 1 : 0})
      ON CONFLICT(space,memory_id) DO UPDATE SET scope_json=excluded.scope_json,scope_key=excluded.scope_key,heads_json=excluded.heads_json,status=excluded.status,payload_ref=excluded.payload_ref,projection_watermark=excluded.projection_watermark,item_json=excluded.item_json,availability_json=excluded.availability_json,generation=excluded.generation,deferred_json=excluded.deferred_json,cleanup_pending=excluded.cleanup_pending,index_state='pending'`,
    );
    if (deferred.some((d) => d.state === "pending")) yield* markRunnable;
  });
  const enqueueWork = Effect.fn("MemoryStore.enqueueWork")(function* (input: MemoryWork) {
    const work = yield* stored("work-codec", decodeWork(input, strict));
    const inserted = yield* stored(
      "outbox",
      sql`INSERT INTO memory_outbox (id,space,memory_id,kind,status,metadata_json,payload_ref,attempt,next_attempt_at,claimed_by,claimed_until) VALUES (${work.id},${work.space},${work.memoryId},${work.kind},${work.status},${yield* workMetadataCodec.encode(work.metadata)},${work.payloadRef},${work.attempt},${work.nextAttemptAt},${work.claimedBy},${work.claimedUntil}) ON CONFLICT(id) DO NOTHING RETURNING id`,
    );
    if (inserted.length && ["pending", "retry"].includes(work.status)) yield* markRunnable;
  });
  const purge = Effect.fnUntraced(function* (
    space: M.MemorySpaceId,
    id: M.MemoryId,
    watermark: number,
  ) {
    const ids = [id];
    const seen = new Set<string>();
    while (ids.length) {
      const current = ids.shift()!;
      if (seen.has(current)) continue;
      seen.add(current);
      const hubExists = yield* stored(
        "hub-purge-inventory",
        sql`SELECT 1 FROM sqlite_master WHERE name='memory_hub_operations'`,
      );
      if (hubExists.length) {
        const entries = yield* stored(
          "hub-purge-tail",
          sql<{
            hub_sequence: number;
            entry_json: string;
          }>`SELECT hub_sequence,entry_json FROM memory_hub_operations WHERE space=${space} AND memory_id=${current}`,
        );
        for (const row of entries) {
          const entry = yield* hubEntryCodec.decode(row.entry_json, strict);
          if (entry.kind === "metadata") continue;
          const op = entry.operation;
          const compactRows = yield* stored(
            "hub-purge-compact",
            sql<{
              compact_json: string;
            }>`SELECT compact_json FROM memory_compact_receipts WHERE space=${space} AND operation_id=${op.operationId}`,
          );
          const redacted: M.MemoryHubEntry = {
            kind: "metadata",
            operationKind: op.kind,
            memoryId: op.memoryId,
            hubSequence: entry.hubSequence,
            receipt: entry.receipt,
            ...(compactRows[0]
              ? { compactReceipt: yield* compactCodec.decode(compactRows[0].compact_json, strict) }
              : {}),
            ...(op.kind === "resolve" ? { resolutionId: op.resolution.resolutionId } : {}),
            ...(op.kind === "forget" ? { tombstone: op.tombstone } : {}),
          };
          yield* stored(
            "hub-purge-redact",
            sql`UPDATE memory_hub_operations SET entry_json=${yield* hubEntryCodec.encode(redacted)},payload_ref=NULL WHERE hub_sequence=${row.hub_sequence}`,
          );
        }
        const snapshots = yield* stored(
          "hub-forget-snapshots",
          sql<{
            pending_key: string;
            metadata_json: string;
          }>`SELECT pending_key,metadata_json FROM memory_inbox_pending WHERE space=${space} AND reason='hub_snapshot'`,
        );
        const beforeSnapshotBytes = yield* snapshotBytes(space);
        for (const row of snapshots) {
          const page = yield* checkpointCodec.decode(row.metadata_json, strict);
          const redacted: M.MemoryHubCheckpointPage = {
            ...page,
            items: page.items.map((item) =>
              item.memoryId !== current || item.status === "forgotten"
                ? item
                : {
                    memorySpaceId: space,
                    memoryId: item.memoryId,
                    status: "blocked" as const,
                    scope: item.scope,
                    pendingSync: false,
                    failureCode: "source_invalidated" as const,
                    localAvailability: {
                      exposure: "held" as const,
                      reasons: ["dependency_invalidated" as const],
                      deferred: [],
                      cleanupPending: false,
                    },
                  },
            ),
            revisions: page.revisions.map((pair) =>
              pair.revision.memoryId === current ? { ...pair, payload: null } : pair,
            ),
            resolutions: page.resolutions.map((pair) =>
              pair.resolution.memoryId === current ? { ...pair, payload: null } : pair,
            ),
            fences: page.fences.map((fence) =>
              fence.memoryId === current ? { ...fence, activeLease: null } : fence,
            ),
          };
          yield* stored(
            "hub-forget-snapshot-redact",
            sql`UPDATE memory_inbox_pending SET metadata_json=${yield* checkpointCodec.encode(redacted)} WHERE space=${space} AND pending_key=${row.pending_key}`,
          );
        }
        const snapshotDelta = (yield* snapshotBytes(space)) - beforeSnapshotBytes;
        // This is a release by approved delete, never a capacity re-admission.
        yield* stored(
          "hub-forget-snapshot-release",
          sql`UPDATE memory_hub_retention SET published_pinned_bytes=max(0,published_pinned_bytes+${snapshotDelta}) WHERE space=${space}`,
        );
        yield* stored(
          "hub-purge-relay",
          sql`DELETE FROM memory_hub_source_reads WHERE space=${space} AND memory_id=${current}`,
        );
        yield* stored(
          "hub-purge-lease",
          sql`UPDATE memory_hub_leases SET lease_json=NULL WHERE space=${space} AND memory_id=${current}`,
        );
      }
      yield* stored(
        "purge-identity-lease",
        sql`UPDATE memory_identity_ledger SET fence_json=json_set(fence_json,'$.activeLease',NULL) WHERE space=${space} AND memory_id=${current}`,
      );
      const dependents = yield* stored(
        "dependencies",
        sql<{
          memory_id: string;
        }>`SELECT DISTINCT p.memory_id FROM memory_payloads p JOIN json_each(p.dependencies_json) d JOIN memory_revisions r ON r.space=p.space AND r.revision_id=d.value WHERE p.space=${space} AND r.memory_id=${current}`,
      );
      for (const row of dependents)
        ids.push(yield* stored("dependency-id", decodeMemoryId(row.memory_id)));
      yield* stored(
        "purge",
        sql`DELETE FROM memory_payloads WHERE space=${space} AND memory_id=${current}`,
      );
      yield* stored(
        "forget-revert-slot",
        sql`UPDATE memory_resolutions SET revert_result_json='{"status":"forgotten"}'
        WHERE space=${space} AND memory_id=${current} AND json_extract(revert_result_json,'$.status')='pending'`,
      );
      yield* stored(
        "purge-revert",
        sql`DELETE FROM memory_revert_intents WHERE space=${space} AND memory_id=${current}`,
      );
      yield* stored(
        "purge-inbox",
        sql`DELETE FROM memory_inbox_pending WHERE space=${space} AND memory_id=${current}`,
      );
      yield* stored(
        "cancel-work",
        // Forget syncs carry delete knowledge; a later purge of the same memory
        // (an expansion or retry) must not cancel an earlier forget's delivery.
        sql`UPDATE memory_outbox SET status='cancelled',payload_ref=NULL WHERE space=${space} AND memory_id=${current} AND status NOT IN ('completed','failed') AND NOT (kind='sync' AND json_extract(metadata_json,'$.kind')='forget')`,
      );
      yield* stored(
        "purge-ticket-submission",
        sql`UPDATE memory_outbox SET ticket_json=json_set(ticket_json,'$.submission',NULL,'$.state','terminal','$.owner',NULL,'$.ownedUntil',NULL,'$.version',sync_version+1),sync_version=sync_version+1,claimed_by=NULL,claimed_until=NULL,payload_ref=NULL WHERE space=${space} AND memory_id=${current} AND kind='resolve' AND ticket_json IS NOT NULL`,
      );
      yield* stored(
        "cancel-claims",
        sql`UPDATE memory_conflicts SET attempt_id=NULL WHERE space=${space} AND memory_id=${current}`,
      );
      const old = yield* readItem(space, current);
      if (current !== id && old && old.item.status !== "forgotten") {
        const blocked: M.MemoryItem = {
          memorySpaceId: space,
          memoryId: current,
          status: "blocked",
          scope: old.item.scope,
          failureCode: "source_invalidated",
          pendingSync: old.item.pendingSync,
          localAvailability: {
            exposure: "held",
            reasons: ["dependency_invalidated"],
            deferred: [],
            cleanupPending: true,
          },
        };
        yield* putItem(blocked, old.heads, watermark);
        yield* emit({
          memorySpaceId: space,
          memoryId: current,
          projectionWatermark: watermark,
          kind: "invalidate",
        });
      }
      const deleted =
        yield* sql`DELETE FROM memory_items_fts WHERE rowid IN (SELECT rowid FROM memory_items WHERE space=${space} AND memory_id=${current})`.pipe(
          Effect.as(true),
          Effect.catch(() => Effect.succeed(false)),
        );
      const fenced = yield* readItem(space, current);
      if (fenced && !deleted) {
        const projection =
          fenced.item.status === "active"
            ? (({ payload: _payload, ...rest }) => rest)(fenced.item)
            : fenced.item;
        const availability = { ...projection.localAvailability, cleanupPending: true };
        yield* stored(
          "purge-observation",
          sql`UPDATE memory_items SET item_json=${yield* projectionCodec.encode({ ...projection, localAvailability: availability })},availability_json=${yield* availabilityCodec.encode(availability)} WHERE space=${space} AND memory_id=${current}`,
        );
      }
      yield* stored(
        "purge-fence",
        sql`UPDATE memory_items SET indexed_bytes=0,index_state=${deleted ? "pending" : "held"},indexed_revision=NULL,indexed_generation=NULL,cleanup_pending=${deleted ? 0 : 1} WHERE space=${space} AND memory_id=${current}`,
      );
    }
  });
  const writeSuppressions = Effect.fnUntraced(function* (t: M.MemoryTombstone) {
    const records = memorySuppressionRecords(t);
    for (const record of records) {
      const json = yield* stored("suppression-codec", suppressionCodec.encode(record));
      // Unique canonical encoded keys keep the permanent union outside bounded wire fragments.
      yield* stored(
        "suppression",
        sql`INSERT INTO memory_import_keys (space,key_kind,key,memory_id,record_json) VALUES (${t.memorySpaceId},${record.kind},${hashText(yield* suppressionKeyCodec.encode(record.kind === "sourceKey" ? { kind: record.kind, value: record.sourceKey } : record.kind === "content" ? { kind: record.kind, value: record.content } : { kind: record.kind, value: record.exclusion }))},${t.memoryId},${json}) ON CONFLICT(space,key_kind,key) DO NOTHING`,
      );
    }
  });
  return {
    putItem,
    enqueueWork,
    purge,
    writeSuppressions,
  };
};

export type ItemWrites = ReturnType<typeof makeItemWrites>;
