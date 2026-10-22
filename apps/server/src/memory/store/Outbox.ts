import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import type { CoreReads } from "./CoreReads.ts";
import type { ImportLineage } from "./ImportLineage.ts";
import type { ItemWrites } from "./ItemWrites.ts";
import type { RevertResults } from "./RevertResults.ts";
import {
  decodeMemorySpaceId,
  decodePendingForget,
  lineageForRevision,
  metadataOf,
  receiptCodec,
  stored,
  workRows,
} from "./StoreCodecs.ts";
import type { WorkRow } from "./StoreCodecs.ts";
import type { StoreKernel } from "./StoreKernel.ts";
import {
  MemoryCapacityError,
  MemoryStoreConflict,
  PendingForgetIntent,
  hashText,
  strict,
} from "./StoreModel.ts";
import type { SyncWorkCandidate } from "./StoreModel.ts";
import type { WorkQueue } from "./WorkQueue.ts";

export const makeOutbox = (
  kernel: Pick<StoreKernel, "emit" | "nextWatermark" | "sql" | "transact">,
  coreReads: Pick<CoreReads, "readItem" | "readPending" | "readWorkOperation">,
  revertResults: Pick<RevertResults, "settleRevertResultTx">,
  itemWrites: Pick<ItemWrites, "enqueueWork" | "putItem">,
  importLineage: Pick<ImportLineage, "persistImportLineageTx" | "settleImportOperationTx">,
  workQueue: Pick<WorkQueue, "finishWork">,
) => {
  const { emit, nextWatermark, sql, transact } = kernel;
  const { readItem, readPending, readWorkOperation } = coreReads;
  const { settleRevertResultTx } = revertResults;
  const { enqueueWork, putItem } = itemWrites;
  const { persistImportLineageTx, settleImportOperationTx } = importLineage;
  const { finishWork } = workQueue;
  const readEligibleOutbox = Effect.fn("MemoryStore.readEligibleOutbox")(function* (
    space: M.MemorySpaceId,
    now: number,
    limit: number,
  ) {
    // Filter before LIMIT: a page of derived work must not hide its unsent inputs.
    // Payload deps are bounded to 100; CROSS JOIN keeps edge iteration ahead of
    // revision/outbox PK probes instead of letting SQLite scan all revisions in a space.
    // Only live local submissions wait. Missing/GC/terminal inputs still reach the hub's
    // authoritative typed rejection, without inventing a receipt or retry attempt here.
    const rows = yield* stored(
      "sync-outbox",
      sql<WorkRow & { sync_version: number; operation_digest: string | null }>`
      SELECT o.* FROM memory_outbox o LEFT JOIN memory_events e ON e.memory_space_id=o.space AND e.operation_id=json_extract(o.metadata_json,'$.operationId')
      WHERE o.space=${space} AND o.kind IN ('sync','revert_intent')
      AND (o.status IN ('pending','retry') OR (o.status='running' AND o.claimed_until<=${now})) AND o.next_attempt_at<=${now}
      AND NOT EXISTS (
        SELECT 1 FROM memory_payloads p CROSS JOIN json_each(p.dependencies_json) dep
        CROSS JOIN memory_revisions r ON r.space=o.space AND r.revision_id=dep.value
        CROSS JOIN memory_outbox prerequisite ON prerequisite.id='sync:'||r.space||':'||r.operation_id
        WHERE p.space=o.space AND p.payload_ref=o.payload_ref
          AND prerequisite.status IN ('pending','retry','running')
      )
      ORDER BY CASE WHEN json_extract(o.metadata_json,'$.kind')='forget'
        THEN CASE WHEN json_extract(e.receipt_json,'$.forgetRetryOf') IS NOT NULL OR
          EXISTS (SELECT 1 FROM memory_events b WHERE b.memory_space_id=o.space AND json_extract(b.receipt_json,'$.forgetExpansion.operationId')=json_extract(o.metadata_json,'$.operationId'))
          THEN 1 ELSE 0 END ELSE 2 END, o.next_attempt_at,o.attempt,o.id
      LIMIT ${Math.max(0, Math.min(limit, M.MEMORY_PAGE_MAX_ITEMS))}`,
    );
    const works = yield* workRows(rows);
    const candidates: SyncWorkCandidate[] = [];
    for (let i = 0; i < rows.length; i++) {
      const work = works[i]!;
      if (!("protocolVersion" in work.metadata)) continue;
      let operationDigest = rows[i]!.operation_digest;
      if (!operationDigest) {
        const op = yield* readWorkOperation(work.id);
        if (!op) continue;
        operationDigest = hashText(M.encodeMemoryOperation(op));
      }
      candidates.push({
        work,
        operationId: work.metadata.operationId,
        operationDigest,
        version: rows[i]!.sync_version,
      });
    }
    return candidates;
  });
  const acknowledgeOutbox = Effect.fn("MemoryStore.acknowledgeOutbox")(function* (
    id: string,
    result: M.MemoryHubReceipt,
  ) {
    return yield* transact(
      Effect.gen(function* () {
        const rows = yield* stored(
          "ack-work",
          sql<
            WorkRow & { completed_receipt_json: string | null }
          >`SELECT * FROM memory_outbox WHERE id=${id} AND kind IN ('sync','revert_intent')`,
        );
        const work = (yield* workRows(rows))[0];
        if (
          !work ||
          !("operationId" in work.metadata) ||
          !("memoryId" in work.metadata) ||
          work.metadata.operationId !== result.operationId ||
          work.metadata.memoryId !== result.memoryId
        )
          return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
        const original = yield* stored(
          "ack-original",
          sql<{
            operation_digest: string;
            receipt_json: string;
          }>`SELECT operation_digest,receipt_json FROM memory_events WHERE memory_space_id=${work.space} AND operation_id=${result.operationId}`,
        );
        if (original[0] && original[0].operation_digest !== result.operationDigest)
          return yield* new MemoryStoreConflict({ code: "operation_id_reused" });
        if (
          (work.status === "completed" || work.status === "failed") &&
          rows[0]?.completed_receipt_json &&
          rows[0].completed_receipt_json === (yield* receiptCodec.encode(result))
        ) {
          yield* settleImportOperationTx(
            yield* stored("import-settlement-space", decodeMemorySpaceId(work.space)),
            result,
          );
          return;
        }
        const previous = original[0]
          ? yield* receiptCodec.decode(original[0].receipt_json, strict)
          : undefined;
        const acknowledged = {
          ...result,
          ...(previous?.forgetExpansion ? { forgetExpansion: previous.forgetExpansion } : {}),
          ...(previous?.forgetRetryOf ? { forgetRetryOf: previous.forgetRetryOf } : {}),
        };
        if (
          previous &&
          "hubSequence" in previous &&
          previous.hubSequence !== null &&
          (yield* receiptCodec.encode(previous)) !== (yield* receiptCodec.encode(acknowledged))
        )
          return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
        const rejectedExpansion =
          result.outcome === "rejected" &&
          work.metadata.kind === "forget" &&
          (yield* stored(
            "ack-forget-expansion",
            sql`SELECT 1 FROM memory_events WHERE memory_space_id=${work.space}
            AND json_extract(receipt_json,'$.forgetExpansion.operationId')=${result.operationId}
            UNION ALL SELECT 1 FROM memory_compact_receipts WHERE space=${work.space}
            AND json_extract(receipt_json,'$.forgetExpansion.operationId')=${result.operationId} LIMIT 1`,
          )).length > 0;
        if (
          (result.hubSequence !== null || rejectedExpansion) &&
          previous &&
          !("hubSequence" in previous)
        )
          yield* stored(
            "ack-settle",
            sql`UPDATE memory_events SET receipt_json=${yield* receiptCodec.encode(acknowledged)} WHERE memory_space_id=${work.space} AND operation_id=${result.operationId}`,
          );
        if (
          result.outcome === "rejected" &&
          result.failureCode === "source_invalidated" &&
          work.metadata.kind === "upsert"
        )
          yield* stored(
            "derived-admission-refusal",
            sql`INSERT INTO memory_quota_counters(space,dimension,scope_key,value) VALUES (${work.space},'derived_admission_rejected','',1) ON CONFLICT(space,dimension,scope_key) DO UPDATE SET value=min(value+1,2147483647)`,
          );
        if (
          result.outcome !== "rejected" &&
          result.hubSequence !== null &&
          "revision" in work.metadata
        )
          yield* persistImportLineageTx(lineageForRevision(work.metadata.revision));
        yield* settleImportOperationTx(
          yield* stored("import-settlement-space", decodeMemorySpaceId(work.space)),
          result,
        );
        if (work.metadata.kind === "revert" && work.metadata.revertsResolutionId)
          yield* settleRevertResultTx(
            yield* stored("revert-space", decodeMemorySpaceId(work.space)),
            result.memoryId,
            work.metadata.revertsResolutionId,
            result,
            work.metadata.revision?.revisionId ?? null,
          );
        yield* finishWork(id, result.outcome === "rejected" ? "failed" : "completed", result);
        if (
          result.outcome === "rejected" &&
          work.metadata.kind === "forget" &&
          "protocolVersion" in work.metadata &&
          work.metadata.tombstone
        ) {
          yield* preserveForgetIntent({
            memorySpaceId: work.metadata.memorySpaceId,
            memoryId: work.metadata.memoryId,
            operationId: work.metadata.operationId,
            requestedAtUtc: work.metadata.tombstone.deletedAtUtc,
            attempts: 0,
            lastFailureCode: result.failureCode ?? null,
            operationDigest: result.operationDigest,
            submissionState: "rejected",
          }).pipe(Effect.catchTags({ MemoryCapacityError: () => Effect.void }));
        }
        if (result.outcome === "rejected" && work.kind === "revert_intent") {
          yield* stored(
            "revert-refusal-terminal",
            sql`DELETE FROM memory_revert_intents WHERE space=${work.space} AND operation_id=${result.operationId}`,
          );
          if (work.payloadRef)
            yield* stored(
              "revert-refusal-payload",
              sql`DELETE FROM memory_payloads WHERE space=${work.space} AND payload_ref=${work.payloadRef} AND NOT EXISTS (SELECT 1 FROM memory_revisions r WHERE r.space=memory_payloads.space AND r.payload_ref=memory_payloads.payload_ref)`,
            );
        }
        if (result.outcome === "rejected")
          yield* stored(
            "forget-rejected",
            sql`UPDATE memory_pending_forget_intents SET submission_state='rejected',last_failure_code=${result.failureCode ?? null} WHERE space=${work.space} AND operation_id=${result.operationId}`,
          );
      }),
    );
  });
  const preserveForgetIntent = Effect.fn("MemoryStore.preserveForgetIntent")(function* (
    input: PendingForgetIntent,
  ) {
    return yield* transact(
      Effect.gen(function* () {
        const intent = yield* stored("pending-forget-codec", decodePendingForget(input, strict));
        const existing = yield* readPending(intent.memorySpaceId, intent.memoryId);
        if (existing) {
          yield* stored(
            "pending-forget-retry",
            sql`UPDATE memory_pending_forget_intents SET attempts=min(attempts+1,2147483647),last_failure_code=${intent.lastFailureCode} WHERE space=${intent.memorySpaceId} AND memory_id=${intent.memoryId}`,
          );
          return;
        }
        const counts = yield* stored(
          "pending-forget-count",
          sql<{ count: number }>`SELECT count(*) AS count FROM memory_pending_forget_intents`,
        );
        if ((counts[0]?.count ?? 0) >= M.MEMORY_PENDING_FORGET_INTENTS_MAX)
          return yield* new MemoryCapacityError({
            dimension: "pendingForgetIntents",
            limit: M.MEMORY_PENDING_FORGET_INTENTS_MAX,
          });
        yield* stored(
          "pending-forget-insert",
          sql`INSERT INTO memory_pending_forget_intents (space,memory_id,operation_id,requested_at_utc,attempts,last_failure_code,operation_digest,submission_state) VALUES (${intent.memorySpaceId},${intent.memoryId},${intent.operationId},${intent.requestedAtUtc},${intent.attempts},${intent.lastFailureCode},${intent.operationDigest},${intent.submissionState})`,
        );
        const old = yield* readItem(intent.memorySpaceId, intent.memoryId);
        if (old && old.item.status !== "forgotten") {
          const watermark = yield* nextWatermark(intent.memorySpaceId);
          yield* putItem(old.item, old.heads, watermark);
          yield* emit({
            memorySpaceId: intent.memorySpaceId,
            memoryId: intent.memoryId,
            projectionWatermark: watermark,
            kind: "invalidate",
          });
        }
      }),
    );
  });
  const enqueuePendingForget = Effect.fn("MemoryStore.enqueuePendingForget")(function* (input: {
    operation: Extract<M.MemoryOperation, { kind: "forget" }>;
    operationDigest: string;
  }) {
    yield* transact(
      Effect.gen(function* () {
        const op = input.operation;
        const intent = yield* readPending(op.memorySpaceId, op.memoryId);
        if (!intent) return yield* new MemoryStoreConflict({ code: "not_found" });
        if (
          intent.submissionState === "uncertain" &&
          (intent.operationId !== op.operationId ||
            intent.operationDigest !== input.operationDigest)
        )
          return yield* new MemoryStoreConflict({ code: "operation_id_reused" });
        if (
          intent.submissionState === "rejected" &&
          intent.operationDigest !== null &&
          intent.operationId === op.operationId
        )
          return yield* new MemoryStoreConflict({ code: "operation_id_reused" });
        yield* enqueueWork({
          id: `sync:${op.memorySpaceId}:${op.operationId}`,
          space: op.memorySpaceId,
          memoryId: op.memoryId,
          kind: "sync",
          status: "pending",
          metadata: metadataOf(op),
          payloadRef: null,
          attempt: 0,
          nextAttemptAt: 0,
          claimedBy: null,
          claimedUntil: null,
        });
        yield* stored(
          "pending-forget-map",
          sql`UPDATE memory_pending_forget_intents SET operation_id=${op.operationId},operation_digest=${input.operationDigest},submission_state='uncertain',attempts=min(attempts+1,2147483647) WHERE space=${op.memorySpaceId} AND memory_id=${op.memoryId}`,
        );
      }),
    );
  });
  const pendingForgetIntents = Effect.fn("MemoryStore.pendingForgetIntents")(function* (
    limit: number,
  ) {
    // A full intent table must not roll back a reserved basic deletion. Recover its independently
    // rejected excess operation into a free bounded slot before scheduling retries.
    const counts = yield* stored(
      "pending-forget-slots",
      sql<{ count: number }>`SELECT count(*) AS count FROM memory_pending_forget_intents`,
    );
    const slots = Math.min(limit, M.MEMORY_PENDING_FORGET_INTENTS_MAX - (counts[0]?.count ?? 0));
    if (slots > 0) {
      const deferred = yield* stored(
        "deferred-forget-intents",
        sql<{
          space: string;
          memory_id: string;
          operation_id: string;
          operation_digest: string;
          requested_at: string;
        }>`SELECT e.memory_space_id AS space,e.memory_id,e.operation_id,e.operation_digest,json_extract(e.metadata_json,'$.tombstone.deletedAtUtc') AS requested_at
        FROM (
          SELECT sequence,memory_space_id,memory_id,operation_id,operation_digest,metadata_json,receipt_json,kind FROM memory_events
          UNION ALL SELECT 0 AS sequence,space AS memory_space_id,memory_id,json_extract(metadata_json,'$.operationId') AS operation_id,json_extract(completed_receipt_json,'$.operationDigest') AS operation_digest,metadata_json,completed_receipt_json AS receipt_json,'forget' AS kind FROM memory_outbox WHERE kind='sync' AND json_extract(metadata_json,'$.kind')='forget' AND status='failed' AND completed_receipt_json IS NOT NULL
        ) e WHERE e.kind='forget' AND json_extract(e.receipt_json,'$.outcome')='rejected'
        AND json_extract(e.receipt_json,'$.failureCode')='capacity_exceeded'
        AND EXISTS (SELECT 1 FROM memory_tombstones t WHERE t.space=e.memory_space_id AND t.memory_id=e.memory_id)
        AND NOT EXISTS (SELECT 1 FROM memory_pending_forget_intents p WHERE p.space=e.memory_space_id AND p.memory_id=e.memory_id)
        AND NOT EXISTS (SELECT 1 FROM (SELECT memory_space_id AS space,receipt_json FROM memory_events UNION ALL SELECT space,receipt_json FROM memory_compact_receipts) r WHERE r.space=e.memory_space_id AND json_extract(r.receipt_json,'$.forgetRetryOf.operationId')=e.operation_id AND json_extract(r.receipt_json,'$.outcome')!='rejected')
        ORDER BY e.sequence LIMIT ${slots}`,
      );
      for (const row of deferred)
        yield* preserveForgetIntent({
          memorySpaceId: M.MemorySpaceId.make(row.space),
          memoryId: M.MemoryId.make(row.memory_id),
          operationId: M.MemoryOperationId.make(row.operation_id),
          operationDigest: row.operation_digest,
          requestedAtUtc: M.MemoryUtcTimestamp.make(row.requested_at),
          attempts: 0,
          lastFailureCode: "capacity_exceeded",
          submissionState: "rejected",
        }).pipe(Effect.catchTags({ MemoryCapacityError: () => Effect.void }));
    }
    const rows = yield* stored(
      "pending-forget-list",
      sql`SELECT space AS memorySpaceId,memory_id AS memoryId,operation_id AS operationId,requested_at_utc AS requestedAtUtc,attempts,last_failure_code AS lastFailureCode,operation_digest AS operationDigest,submission_state AS submissionState FROM memory_pending_forget_intents ORDER BY requested_at_utc,space,memory_id LIMIT ${Math.min(limit, M.MEMORY_PENDING_FORGET_INTENTS_MAX)}`,
    );
    return yield* stored(
      "pending-forget-codec",
      Effect.forEach(rows, (row) => decodePendingForget(row, strict)),
    );
  });
  const settleForgetIntent = Effect.fn("MemoryStore.settleForgetIntent")(function* (
    space: M.MemorySpaceId,
    id: M.MemoryId,
  ) {
    return yield* transact(
      Effect.gen(function* () {
        const tombstones = yield* stored(
          "settle-forget-check",
          sql`SELECT 1 FROM memory_tombstones WHERE space=${space} AND memory_id=${id}`,
        );
        if (!tombstones.length) return yield* new MemoryStoreConflict({ code: "forgotten" });
        yield* stored(
          "settle-forget",
          sql`DELETE FROM memory_pending_forget_intents WHERE space=${space} AND memory_id=${id}`,
        );
      }),
    );
  });
  return {
    readEligibleOutbox,
    acknowledgeOutbox,
    preserveForgetIntent,
    enqueuePendingForget,
    pendingForgetIntents,
    settleForgetIntent,
  };
};

export type Outbox = ReturnType<typeof makeOutbox>;
