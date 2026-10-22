import * as M from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { CoreReads } from "./CoreReads.ts";
import {
  availabilityCodec,
  codec,
  decodeMemoryId,
  decodeMemorySpaceId,
  deferredCodec,
  deferredRowCodec,
  projectionCodec,
  rulesCodec,
  stored,
  workMetadataCodec,
} from "./StoreCodecs.ts";
import type { StoreKernel } from "./StoreKernel.ts";
import { MemoryStorageError, MemoryWork, strict } from "./StoreModel.ts";
import type { MemoryDeferredWork } from "./StoreModel.ts";
import type { WorkQueue } from "./WorkQueue.ts";

const scannerPayloadCodec = codec(Schema.Union([M.MemoryPayload, M.MemoryResolutionPayload]));

export const makeDeferredWork = (
  kernel: Pick<StoreKernel, "emit" | "nextWatermark" | "sql" | "transact">,
  coreReads: Pick<CoreReads, "loadAggregate" | "readItem" | "readPending">,
  workQueue: Pick<WorkQueue, "finishWork" | "readWork">,
) => {
  const { emit, nextWatermark, sql, transact } = kernel;
  const { loadAggregate, readItem, readPending } = coreReads;
  const { finishWork, readWork } = workQueue;
  const readDeferred = Effect.fn("MemoryStore.readDeferred")(function* (
    now: number,
    limit: number,
  ) {
    const maxItems = Math.max(0, Math.min(limit, M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS));
    // Limit runnable work rows, not items containing held or currently claimed work.
    const rows = yield* stored(
      "deferred",
      sql<{
        space: string;
        memory_id: string;
        deferred_json: string;
        payload_bytes: number;
      }>`SELECT i.space,i.memory_id,d.value AS deferred_json,
      CASE WHEN json_extract(d.value,'$.kind')='scanner' THEN
        min(coalesce((SELECT sum(payload_bytes) FROM (SELECT length(CAST(body_json AS BLOB)) AS payload_bytes FROM memory_payloads p WHERE p.space=i.space AND p.memory_id=i.memory_id AND p.payload_ref NOT LIKE 'relay:%' AND p.payload_ref NOT LIKE 'submission:%' AND p.payload_ref>coalesce(json_extract(d.value,'$.scannerCursor'),'') ORDER BY p.payload_ref LIMIT ${M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS})),0),${Math.min(M.MEMORY_DEFERRED_SWEEP_MAX_BYTES, M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS * M.MEMORY_PAYLOAD_MAX_UTF8_BYTES)})
      WHEN json_extract(d.value,'$.kind')='index' THEN coalesce((SELECT length(CAST(p.body_json AS BLOB)) FROM memory_payloads p JOIN memory_revisions r ON r.space=p.space AND r.payload_ref=p.payload_ref WHERE r.space=i.space AND r.memory_id=i.memory_id AND r.revision_id=json_extract(d.value,'$.revisionId')),0)
      ELSE 0 END AS payload_bytes
      FROM memory_items i JOIN json_each(i.deferred_json) d
      WHERE i.status!='forgotten' AND json_extract(d.value,'$.state')='pending'
      AND json_extract(d.value,'$.dueAt')<=${now}
      AND (json_extract(d.value,'$.claimedUntil') IS NULL OR json_extract(d.value,'$.claimedUntil')<=${now})
      ORDER BY json_extract(d.value,'$.dueAt'),json_extract(d.value,'$.lastAttemptAt') NULLS FIRST,i.memory_id,json_extract(d.value,'$.kind'),i.space
      LIMIT ${maxItems}`,
    );
    const selected: MemoryDeferredWork[] = [];
    const charged = new Set<string>();
    let bytes = 0;
    for (const row of rows) {
      const memorySpaceId = yield* stored("deferred-space", decodeMemorySpaceId(row.space));
      const memoryId = yield* stored("deferred-memory", decodeMemoryId(row.memory_id));
      const work = yield* deferredRowCodec.decode(row.deferred_json, strict);
      const key = `${memorySpaceId}:${memoryId}:${work.kind}`;
      const charge = charged.has(key) ? 0 : row.payload_bytes;
      if (bytes + charge > M.MEMORY_DEFERRED_SWEEP_MAX_BYTES) continue;
      bytes += charge;
      charged.add(key);
      selected.push({ ...work, memorySpaceId, memoryId, payloadBytes: row.payload_bytes });
    }
    return selected;
  });
  const readScannerChunk = Effect.fn("MemoryStore.readScannerChunk")(function* (
    target: MemoryDeferredWork,
  ) {
    const rows = yield* stored(
      "scanner-chunk",
      sql<{ payload_ref: string; body_json: string; bytes: number }>`
      SELECT p.payload_ref,p.body_json,length(CAST(p.body_json AS BLOB)) AS bytes FROM memory_payloads p
      JOIN memory_items i ON i.space=p.space AND i.memory_id=p.memory_id
      WHERE p.space=${target.memorySpaceId} AND p.memory_id=${target.memoryId} AND i.generation=${target.generation} AND i.status!='forgotten'
      AND p.payload_ref NOT LIKE 'relay:%' AND p.payload_ref NOT LIKE 'submission:%'
      AND p.payload_ref>${target.scannerCursor ?? ""} ORDER BY p.payload_ref LIMIT ${M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS + 1}`,
    );
    const selected = [];
    let bytes = 0;
    for (const row of rows) {
      if (
        selected.length === M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS ||
        bytes + row.bytes > M.MEMORY_DEFERRED_SWEEP_MAX_BYTES
      )
        break;
      selected.push(row);
      bytes += row.bytes;
    }
    if (rows.length && !selected.length)
      return yield* new MemoryStorageError({
        stage: "scanner-chunk-oversized",
        cause: new Error("Canonical payload exceeds scanner chunk budget"),
      });
    return {
      payloads: yield* Effect.forEach(selected, (row) =>
        scannerPayloadCodec.decode(row.body_json, strict),
      ),
      nextCursor: selected.length < rows.length ? selected.at(-1)!.payload_ref : null,
    };
  });
  const claimDeferred = Effect.fn("MemoryStore.claimDeferred")(function* (
    target: MemoryDeferredWork,
    owner: string,
    now: number,
    until: number,
  ) {
    return yield* transact(
      Effect.gen(function* () {
        const rows = yield* stored(
          "deferred-claim",
          sql<{
            generation: number;
            deferred_json: string;
            status: string;
          }>`SELECT generation,deferred_json,status FROM memory_items WHERE space=${target.memorySpaceId} AND memory_id=${target.memoryId}`,
        );
        const row = rows[0];
        if (!row || row.generation !== target.generation || row.status === "forgotten")
          return false;
        const deferred = yield* stored(
          "deferred-codec",
          deferredCodec.decode(row.deferred_json, strict),
        );
        const current = deferred.find((d) => d.kind === target.kind);
        if (
          !current ||
          current.scannerCursor !== target.scannerCursor ||
          current.state !== "pending" ||
          current.dueAt > now ||
          (current.claimedUntil !== null && current.claimedUntil > now)
        )
          return false;
        const updated = deferred.map((d) =>
          d.kind === target.kind
            ? { ...d, claimedBy: owner, claimedUntil: until, lastAttemptAt: now }
            : d,
        );
        yield* stored(
          "deferred-claim-write",
          sql`UPDATE memory_items SET deferred_json=${yield* deferredCodec.encode(updated)} WHERE space=${target.memorySpaceId} AND memory_id=${target.memoryId} AND generation=${target.generation}`,
        );
        return true;
      }),
    );
  });
  const finishDeferred = Effect.fn("MemoryStore.finishDeferred")(function* (
    target: MemoryDeferredWork,
    outcome: {
      now: number;
      failure?: M.MemoryDeferredReason;
      scannerPolicyVersion?: number;
      scannerCursor?: string;
      ruleIds?: ReadonlyArray<string>;
    },
  ) {
    return yield* transact(
      Effect.gen(function* () {
        const rows = yield* stored(
          "deferred-finish",
          sql<{
            generation: number;
            deferred_json: string;
            status: string;
          }>`SELECT generation,deferred_json,status FROM memory_items WHERE space=${target.memorySpaceId} AND memory_id=${target.memoryId}`,
        );
        const row = rows[0];
        if (!row || row.generation !== target.generation || row.status === "forgotten")
          return false;
        const deferred = yield* stored(
          "deferred-codec",
          deferredCodec.decode(row.deferred_json, strict),
        );
        const updated = deferred.map((d) =>
          d.kind === target.kind
            ? {
                ...d,
                ...(outcome.scannerCursor ? { scannerCursor: outcome.scannerCursor } : {}),
                state:
                  outcome.scannerCursor && !outcome.failure
                    ? ("pending" as const)
                    : outcome.failure === "secret_detected"
                      ? ("held" as const)
                      : outcome.failure
                        ? ("pending" as const)
                        : ("ready" as const),
                reason: outcome.failure ?? null,
                sinceAtUtc: outcome.failure ? d.sinceAtUtc : null,
                attempt: outcome.failure ? Math.min(d.attempt + 1, 2147483647) : d.attempt,
                dueAt: outcome.failure
                  ? outcome.now + Math.min(2 ** Math.min(d.attempt + 1, 10) * 5000, 3600000)
                  : d.dueAt,
                claimedBy: null,
                claimedUntil: null,
              }
            : d,
        );
        yield* stored(
          "deferred-finish-write",
          sql`UPDATE memory_items SET deferred_json=${yield* deferredCodec.encode(updated)},scanner_policy_version=coalesce(${outcome.scannerCursor ? null : (outcome.scannerPolicyVersion ?? null)},scanner_policy_version),scanned_at=CASE WHEN ${target.kind}='scanner' AND ${outcome.scannerCursor ?? null} IS NULL THEN ${outcome.now} ELSE scanned_at END WHERE space=${target.memorySpaceId} AND memory_id=${target.memoryId} AND generation=${target.generation}`,
        );
        if (outcome.scannerCursor && !outcome.failure) return true;
        const old = yield* readItem(target.memorySpaceId, target.memoryId);
        if (old && old.item.status !== "forgotten" && target.kind === "scanner") {
          const aggregate = yield* loadAggregate(
            target.memorySpaceId,
            target.memoryId,
            { heads: true },
            {},
          );
          const pending = yield* readPending(target.memorySpaceId, target.memoryId);
          const reasons = old.item.localAvailability.reasons.filter(
            (reason) => !["scanner_pending", "secret_detected"].includes(reason),
          );
          if (outcome.failure) reasons.push(outcome.failure);
          if (pending && !reasons.includes("forget_pending")) reasons.push("forget_pending");
          const localAvailability: M.MemoryLocalAvailability = {
            ...old.item.localAvailability,
            reasons,
            deferred: updated.map((d) => ({
              kind: d.kind,
              state: d.state,
              reason: d.reason,
              revisionId: d.revisionId,
              generation: d.generation,
              sinceAtUtc: d.sinceAtUtc,
            })),
            exposure: reasons.some((r) =>
              [
                "scanner_pending",
                "secret_detected",
                "missing_parent",
                "dependency_invalidated",
                "forget_pending",
              ].includes(r),
            )
              ? "held"
              : old.item.status === "quarantined"
                ? "held"
                : "visible",
          };
          const single = aggregate.revisions.find(
            (pair) => pair.revision.revisionId === aggregate.heads[0],
          );
          const projected =
            localAvailability.exposure === "visible" &&
            aggregate.heads.length === 1 &&
            single?.payload
              ? {
                  memorySpaceId: target.memorySpaceId,
                  memoryId: target.memoryId,
                  pendingSync: old.item.pendingSync,
                  status: "active" as const,
                  scope: single.revision.scope,
                  revision: single.revision,
                  localAvailability,
                }
              : { ...old.item, localAvailability };
          yield* stored(
            "scanner-projection",
            sql`UPDATE memory_items SET item_json=${yield* projectionCodec.encode(projected)},availability_json=${yield* availabilityCodec.encode(localAvailability)},status=${projected.status},payload_ref=${projected.status === "active" ? projected.revision.payloadRef : null},scanner_rules_json=${yield* rulesCodec.encode(outcome.ruleIds ?? [])} WHERE space=${target.memorySpaceId} AND memory_id=${target.memoryId} AND generation=${target.generation}`,
          );
        }
        if (target.kind === "scanner") {
          const watermark = yield* nextWatermark(target.memorySpaceId);
          yield* stored(
            "scanner-watermark",
            sql`UPDATE memory_items SET projection_watermark=${watermark} WHERE space=${target.memorySpaceId} AND memory_id=${target.memoryId}`,
          );
          yield* emit({
            memorySpaceId: target.memorySpaceId,
            memoryId: target.memoryId,
            projectionWatermark: watermark,
            kind: "invalidate",
          });
        }
        return true;
      }),
    );
  });
  const finishOwnedDeferred = Effect.fn("MemoryStore.finishOwnedDeferred")(function* (
    target: MemoryDeferredWork,
    owner: string,
    until: number,
    outcome: {
      now: number;
      failure?: M.MemoryDeferredReason;
      scannerPolicyVersion?: number;
      scannerCursor?: string;
      ruleIds?: ReadonlyArray<string>;
    },
  ) {
    return yield* transact(
      Effect.gen(function* () {
        const rows = yield* stored(
          "deferred-owner",
          sql<{
            deferred_json: string;
          }>`SELECT deferred_json FROM memory_items WHERE space=${target.memorySpaceId} AND memory_id=${target.memoryId} AND generation=${target.generation}`,
        );
        if (!rows[0]) return false;
        const current = (yield* deferredCodec.decode(rows[0].deferred_json, strict)).find(
          (d) => d.kind === target.kind,
        );
        if (
          !current ||
          current.scannerCursor !== target.scannerCursor ||
          current.claimedBy !== owner ||
          current.claimedUntil !== until ||
          current.revisionId !== target.revisionId ||
          until <= (yield* Clock.currentTimeMillis)
        )
          return false;
        return yield* finishDeferred(target, outcome);
      }),
    );
  });
  const completeSummaryWork = Effect.fn("MemoryStore.completeSummaryWork")(function* (
    work: MemoryWork,
  ) {
    return yield* transact(
      Effect.gen(function* () {
        const current = yield* readWork(work.id);
        if (
          work.metadata.kind !== "summary" ||
          !current ||
          current.kind !== work.kind ||
          (yield* workMetadataCodec.encode(current.metadata)) !==
            (yield* workMetadataCodec.encode(work.metadata)) ||
          current.status !== "running" ||
          current.claimedBy !== work.claimedBy ||
          current.claimedUntil !== work.claimedUntil ||
          current.attempt !== work.attempt ||
          current.claimedUntil === null ||
          current.claimedUntil <= (yield* Clock.currentTimeMillis)
        )
          return false;
        yield* finishWork(work.id, "completed");
        const meta = work.metadata;
        yield* stored(
          "summary-completion-clock",
          sql`UPDATE memory_outbox SET metadata_json=${yield* workMetadataCodec.encode({ ...meta, completedAt: yield* Clock.currentTimeMillis })} WHERE id=${work.id}`,
        );
        yield* stored(
          "summary-compact",
          sql`DELETE FROM memory_outbox WHERE kind=${work.kind} AND status='completed' AND id!=${work.id}
        AND json_extract(metadata_json,'$.kind')='summary' AND json_extract(metadata_json,'$.sourceThread.environmentId')=${meta.sourceThread.environmentId}
        AND json_extract(metadata_json,'$.sourceThread.threadId')=${meta.sourceThread.threadId}
        AND json_extract(metadata_json,'$.sourceWatermark.throughSequence')<${meta.sourceWatermark.throughSequence}`,
        );
        return true;
      }),
    );
  });
  const recoverDeferred = Effect.fn("MemoryStore.recoverDeferred")(function* (
    scannerPolicyVersion: number,
    now: number,
  ) {
    yield* transact(
      Effect.gen(function* () {
        const rows = yield* stored(
          "deferred-recovery",
          sql<{
            space: string;
            memory_id: string;
            generation: number;
            scanner_policy_version: number;
            deferred_json: string;
          }>`SELECT i.space,i.memory_id,i.generation,i.scanner_policy_version,i.deferred_json FROM memory_items i
          WHERE i.status!='forgotten' AND EXISTS (SELECT 1 FROM json_each(i.deferred_json) d
            WHERE json_extract(d.value,'$.state')='held' AND (
              (json_extract(d.value,'$.kind')='scanner' AND json_extract(d.value,'$.reason')='secret_detected' AND i.scanner_policy_version<${scannerPolicyVersion}) OR
              (json_extract(d.value,'$.kind')='index' AND json_extract(d.value,'$.reason')='fts_braked' AND NOT EXISTS (SELECT 1 FROM memory_fts_maintenance_state WHERE state='braked'))))
          ORDER BY i.space,i.memory_id LIMIT ${M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS}`,
        );
        const brake = yield* stored(
          "deferred-brake",
          sql`SELECT 1 FROM memory_fts_maintenance_state WHERE state='braked'`,
        );
        for (const row of rows) {
          const deferred = yield* deferredCodec.decode(row.deferred_json, strict);
          const updated = deferred.map((d) => {
            const { scannerCursor: _cursor, ...reset } = d;
            return d.state === "held" &&
              ((d.kind === "scanner" &&
                d.reason === "secret_detected" &&
                row.scanner_policy_version < scannerPolicyVersion) ||
                (d.kind === "index" && d.reason === "fts_braked" && !brake.length))
              ? {
                  ...(d.kind === "scanner" ? reset : d),
                  state: "pending" as const,
                  dueAt: now,
                  claimedBy: null,
                  claimedUntil: null,
                }
              : d;
          });
          yield* stored(
            "deferred-release",
            sql`UPDATE memory_items SET deferred_json=${yield* deferredCodec.encode(updated)} WHERE space=${row.space} AND memory_id=${row.memory_id} AND generation=${row.generation}`,
          );
        }
      }),
    );
  });
  return {
    readDeferred,
    readScannerChunk,
    claimDeferred,
    finishDeferred,
    finishOwnedDeferred,
    completeSummaryWork,
    recoverDeferred,
  };
};

export type DeferredWork = ReturnType<typeof makeDeferredWork>;
