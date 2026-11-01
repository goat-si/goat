import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import type { Accounting } from "./Accounting.ts";
import type { CoreReads } from "./CoreReads.ts";
import type { ImportLineage } from "./ImportLineage.ts";
import type { ItemWrites } from "./ItemWrites.ts";
import type { Reports } from "./Reports.ts";
import {
  boundaryCodec,
  checkpointCodec,
  decodeCheckpoint,
  executionCodec,
  fenceCodec,
  headsCodec,
  identityCodec,
  payloadCodec,
  provenanceCodec,
  resolutionCodec,
  resolutionPayloadCodec,
  scopeCodec,
  selectionCodec,
  stagedCheckpointCodec,
  stored,
  suppressionCodec,
  suppressionKeyCodec,
} from "./StoreCodecs.ts";
import type { StoreKernel } from "./StoreKernel.ts";
import {
  MemoryStoreConflict,
  Transaction,
  hasSourceEvidence,
  hashText,
  strict,
} from "./StoreModel.ts";
import type { CheckpointStageIdentity } from "./StoreModel.ts";
import type { MemoryStoreShape } from "./StoreShape.ts";

export const makeCheckpoints = (
  kernel: Pick<StoreKernel, "emit" | "nextWatermark" | "sql" | "transact">,
  coreReads: Pick<CoreReads, "loadAggregate" | "readItem">,
  itemWrites: Pick<ItemWrites, "purge" | "putItem">,
  accounting: Pick<Accounting, "persistCompactReceipt" | "reservationForRevisions">,
  importLineage: Pick<ImportLineage, "persistImportLineageTx">,
  reports: Pick<Reports, "reconcileResolutionReportTx">,
) => {
  const { emit, nextWatermark, sql, transact } = kernel;
  const { loadAggregate, readItem } = coreReads;
  const { purge, putItem } = itemWrites;
  const { persistCompactReceipt, reservationForRevisions } = accounting;
  const { persistImportLineageTx } = importLineage;
  const { reconcileResolutionReportTx } = reports;
  // The writer lock is held by transact before reading the stage. A page from
  // a discarded snapshot must not recreate its bodies or publish over a new join.
  const requireCheckpointStage = Effect.fnUntraced(function* (input: CheckpointStageIdentity) {
    yield* Transaction;
    const rows = yield* stored(
      "checkpoint-stage-identity",
      sql`SELECT 1 FROM memory_sync_cursors WHERE space=${input.memorySpaceId} AND hub_environment_id=${input.hubEnvironmentId} AND bootstrap_state='staging' AND snapshot_token=${input.expectedSnapshotToken} AND checkpoint_id=${input.checkpointId} AND checkpoint_sequence=${input.expectedCheckpointSequence}`,
    );
    if (!rows.length) return yield* new MemoryStoreConflict({ code: "revision_changed" });
  });
  const installCheckpointPage: MemoryStoreShape["installCheckpointPage"] = Effect.fn(
    "MemoryStore.installCheckpointPage",
  )(function* (input) {
    yield* transact(
      Effect.gen(function* () {
        const page = yield* stored("checkpoint-codec", decodeCheckpoint(input.page, strict));
        if (
          page.memorySpaceId !== input.memorySpaceId ||
          page.checkpointSequence !== input.expectedCheckpointSequence
        )
          return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
        yield* requireCheckpointStage(input);
        const pageDigest = hashText(yield* checkpointCodec.encode(page));
        const existing = yield* stored(
          "checkpoint-page",
          sql<{
            metadata_json: string;
            operation_digest: string;
          }>`SELECT metadata_json,operation_digest FROM memory_inbox_pending WHERE space=${page.memorySpaceId} AND checkpoint_id=${input.checkpointId} AND page_ordinal=${page.pageOrdinal}`,
        );
        const safePage = {
          ...page,
          items: page.items.map((item) =>
            item.status === "active"
              ? {
                  memorySpaceId: item.memorySpaceId,
                  memoryId: item.memoryId,
                  pendingSync: item.pendingSync,
                  status: "blocked" as const,
                  scope: item.scope,
                  failureCode: "scanner_pending" as const,
                  localAvailability: {
                    exposure: "held" as const,
                    reasons: ["scanner_pending" as const],
                    deferred: [],
                    cleanupPending: false,
                  },
                }
              : item,
          ),
          revisions: page.revisions.map((pair) => ({ ...pair, payload: null })),
          resolutions: page.resolutions.map((pair) => ({ ...pair, payload: null })),
        };
        const json = yield* stagedCheckpointCodec.encode({
          page: safePage,
          heads: page.items.map((item) => ({
            memoryId: item.memoryId,
            heads:
              item.status === "active"
                ? [item.revision.revisionId]
                : item.status === "quarantined"
                  ? item.conflict.heads
                  : [],
          })),
        });
        if (existing[0]) {
          if (existing[0].metadata_json !== json || existing[0].operation_digest !== pageDigest)
            return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
          return;
        }
        for (const pair of page.revisions) {
          if (!pair.payload) continue;
          const forgotten = yield* stored(
            "checkpoint-forget",
            sql`SELECT 1 FROM memory_tombstones WHERE space=${page.memorySpaceId} AND memory_id=${pair.revision.memoryId}`,
          );
          if (forgotten.length) continue;
          yield* stored(
            "checkpoint-payload",
            sql`INSERT INTO memory_payloads (space,payload_ref,memory_id,body_json,dependencies_json,checkpoint_stage_id) VALUES (${page.memorySpaceId},${pair.revision.payloadRef},${pair.revision.memoryId},${yield* payloadCodec.encode(pair.payload)},${yield* headsCodec.encode(pair.payload.derivedFromMemoryRevisions)},${input.checkpointId}) ON CONFLICT(space,payload_ref) DO NOTHING`,
          );
        }
        for (const pair of page.resolutions)
          if (pair.payload) {
            const forgotten = yield* stored(
              "checkpoint-forget",
              sql`SELECT 1 FROM memory_tombstones WHERE space=${page.memorySpaceId} AND memory_id=${pair.resolution.memoryId}`,
            );
            if (forgotten.length) continue;
            yield* stored(
              "checkpoint-judgment",
              sql`INSERT INTO memory_payloads (space,payload_ref,memory_id,body_json,dependencies_json,resolved_at,revert_deadline,purge_eligible_after,checkpoint_stage_id) VALUES (${page.memorySpaceId},${pair.resolution.judgmentRef},${pair.resolution.memoryId},${yield* resolutionPayloadCodec.encode(pair.payload)},${yield* headsCodec.encode(pair.resolution.inputRevisionIds)},${Date.parse(pair.resolution.appliedAtUtc)},${Date.parse(pair.resolution.revertDeadlineUtc)},${Date.parse(pair.resolution.appliedAtUtc) + M.MEMORY_REPLACED_PAYLOAD_RETENTION_MS},${input.checkpointId}) ON CONFLICT(space,payload_ref) DO NOTHING`,
            );
          }
        yield* stored(
          "checkpoint-stage",
          sql`INSERT INTO memory_inbox_pending (space,pending_key,record_kind,missing_parents_json,reason,hub_sequence,checkpoint_id,page_ordinal,metadata_json,operation_digest) VALUES (${page.memorySpaceId},${`checkpoint:${input.checkpointId}:${page.pageOrdinal}`},'checkpoint','[]','scanner_pending',${page.checkpointSequence},${input.checkpointId},${page.pageOrdinal},${json},${pageDigest})`,
        );
      }),
    );
  });
  const completeCheckpoint: MemoryStoreShape["completeCheckpoint"] = Effect.fn(
    "MemoryStore.completeCheckpoint",
  )(function* (input) {
    yield* transact(
      Effect.gen(function* () {
        yield* requireCheckpointStage(input);
        const rows = yield* stored(
          "checkpoint-pages",
          sql<{
            metadata_json: string;
          }>`SELECT metadata_json FROM memory_inbox_pending WHERE space=${input.memorySpaceId} AND checkpoint_id=${input.checkpointId} AND record_kind='checkpoint' ORDER BY page_ordinal`,
        );
        const staged = yield* Effect.forEach(rows, (row) =>
          stagedCheckpointCodec.decode(row.metadata_json, strict),
        );
        const pages = staged.map((record) => record.page);
        if (
          pages.length !== input.pageCount ||
          !pages.length ||
          pages.some(
            (p, i) =>
              p.pageOrdinal !== i ||
              p.memorySpaceId !== input.memorySpaceId ||
              p.checkpointSequence !== input.expectedCheckpointSequence,
          ) ||
          !pages.at(-1)?.bootstrapComplete ||
          !M.validateMemoryCheckpointRecords(pages)
        )
          return yield* new MemoryStoreConflict({ code: "bootstrap_required" });
        const last = pages.at(-1)!;
        const checkpointWatermark = yield* nextWatermark(input.memorySpaceId);
        for (const page of pages) {
          for (const identity of page.identities)
            yield* stored(
              "checkpoint-identity",
              sql`INSERT INTO memory_identity_ledger (space,memory_id,identity_json,fence_json,reserve_bytes) VALUES (${input.memorySpaceId},${identity.memoryId},${yield* identityCodec.encode(identity)},${yield* fenceCodec.encode(page.fences.find((f) => f.memoryId === identity.memoryId) ?? { memorySpaceId: input.memorySpaceId, memoryId: identity.memoryId, highestFencingToken: 0, activeLease: null })},${M.MEMORY_IDENTITY_CORE_MAX_BYTES + M.MEMORY_PAYLOAD_MAX_UTF8_BYTES}) ON CONFLICT(space,memory_id) DO NOTHING`,
            );
          for (const fence of page.fences)
            yield* stored(
              "checkpoint-fence",
              sql`UPDATE memory_identity_ledger SET fence_json=${yield* fenceCodec.encode(fence)} WHERE space=${input.memorySpaceId} AND memory_id=${fence.memoryId}`,
            );
          for (const conflict of page.conflicts)
            yield* stored(
              "checkpoint-conflict",
              sql`INSERT INTO memory_conflicts (space,conflict_id,memory_id,heads_json,status,failure_code) VALUES (${input.memorySpaceId},${conflict.conflictId},${conflict.memoryId},${yield* headsCodec.encode(conflict.heads)},${conflict.status},${conflict.failureCode ?? null}) ON CONFLICT(space,conflict_id) DO UPDATE SET heads_json=excluded.heads_json,status=excluded.status,failure_code=excluded.failure_code`,
            );
          for (const pair of page.resolutions) {
            const r = pair.resolution;
            const execution: M.MemoryGenerationExecution = {
              requestedModelSelection: r.requestedModelSelection,
              effectiveProvider: r.effectiveProvider,
              effectiveModel: r.effectiveModel,
              providerInstanceId: r.requestedModelSelection.instanceId,
              environmentId: r.resolvingEnvironmentId,
            };
            yield* stored(
              "checkpoint-resolution",
              sql`INSERT INTO memory_resolutions (space,resolution_id,memory_id,input_revision_ids_json,input_payload_refs_json,judgment_payload_ref,requested_model_selection_json,effective_provider_model_json,resolving_environment_id,fencing_token,result_revision_id,applied_at,revert_deadline,resolution_json) VALUES (${input.memorySpaceId},${r.resolutionId},${r.memoryId},${yield* headsCodec.encode(r.inputRevisionIds)},${yield* headsCodec.encode(r.inputPayloadRefs)},${r.judgmentRef},${yield* selectionCodec.encode(r.requestedModelSelection)},${yield* executionCodec.encode(execution)},${r.resolvingEnvironmentId},${r.fencingToken},${r.resultRevisionId},${Date.parse(r.appliedAtUtc)},${Date.parse(r.revertDeadlineUtc)},${yield* resolutionCodec.encode(r)}) ON CONFLICT(space,resolution_id) DO NOTHING`,
            );
          }
          for (const pair of page.revisions) {
            const r = pair.revision;
            yield* stored(
              "checkpoint-revision",
              sql`INSERT INTO memory_revisions (space,revision_id,memory_id,operation_id,parents_json,scope_json,assertion_kind,provenance_json,payload_ref,created_at) VALUES (${input.memorySpaceId},${r.revisionId},${r.memoryId},${r.operationId},${yield* headsCodec.encode(r.parents)},${yield* scopeCodec.encode(r.scope)},${r.assertionKind},${yield* provenanceCodec.encode(r.provenance)},${r.payloadRef},${Date.parse(r.createdAtUtc)}) ON CONFLICT(space,revision_id) DO NOTHING`,
            );
          }
          for (const tombstone of page.tombstones) {
            yield* stored(
              "checkpoint-tombstone",
              sql`INSERT INTO memory_tombstones (space,memory_id,delete_operation_id,deleting_environment_id,deleted_at,suppressed_source_keys_json,suppressed_content_json,source_exclusions_json) VALUES (${input.memorySpaceId},${tombstone.memoryId},${tombstone.deleteOperationId},${tombstone.deletingEnvironmentId},${Date.parse(tombstone.deletedAtUtc)},'[]','[]','[]') ON CONFLICT(space,memory_id) DO NOTHING`,
            );
            yield* purge(input.memorySpaceId, tombstone.memoryId, checkpointWatermark);
            yield* stored(
              "checkpoint-forget-reserve-consumed",
              sql`UPDATE memory_identity_ledger SET reserve_bytes=${M.MEMORY_IDENTITY_CORE_MAX_BYTES},reserve_keys=0 WHERE space=${input.memorySpaceId} AND memory_id=${tombstone.memoryId}`,
            );
          }
          for (const record of page.suppressions) {
            const json = yield* suppressionCodec.encode(record);
            const key = hashText(
              yield* suppressionKeyCodec.encode(
                record.kind === "sourceKey"
                  ? { kind: record.kind, value: record.sourceKey }
                  : record.kind === "content"
                    ? { kind: record.kind, value: record.content }
                    : { kind: record.kind, value: record.exclusion },
              ),
            );
            yield* stored(
              "checkpoint-suppression",
              sql`INSERT INTO memory_import_keys (space,key_kind,key,memory_id,record_json) VALUES (${input.memorySpaceId},${record.kind},${key},${record.memoryId},${json}) ON CONFLICT(space,key_kind,key) DO NOTHING`,
            );
          }
          for (const item of page.items) {
            const old = yield* readItem(input.memorySpaceId, item.memoryId);
            if (old?.item.status === "forgotten" || old?.item.pendingSync) continue;
            const forgotten = yield* stored(
              "checkpoint-forgotten",
              sql`SELECT 1 FROM memory_tombstones WHERE space=${input.memorySpaceId} AND memory_id=${item.memoryId}`,
            );
            if (forgotten.length && item.status !== "forgotten") continue;
            const heads =
              staged
                .flatMap((record) => record.heads)
                .find((record) => record.memoryId === item.memoryId)?.heads ?? [];
            yield* putItem(item, heads, checkpointWatermark);
          }
        }
        // Every resolution must exist before receipt settlement, independent of page boundaries.
        for (const page of pages) {
          for (const compact of page.compactReceipts) {
            yield* persistCompactReceipt(compact);
            if (input.localEnvironmentId)
              yield* reconcileResolutionReportTx({
                record: compact,
                localEnvironmentId: input.localEnvironmentId,
              });
          }
        }
        yield* persistImportLineageTx(pages.flatMap((page) => page.importLineage));
        for (const identity of pages.flatMap((page) => page.identities)) {
          const current = yield* loadAggregate(
            input.memorySpaceId,
            identity.memoryId,
            { when: hasSourceEvidence },
            { importLineage: true },
          );
          if (current.tombstone) continue;
          const reservation = yield* reservationForRevisions(
            {
              memorySpaceId: input.memorySpaceId,
              memoryId: identity.memoryId,
              operationId: identity.createOperationId,
            },
            current.revisions,
          );
          yield* stored(
            "checkpoint-forget-reservation",
            sql`UPDATE memory_identity_ledger SET reserve_bytes=max(reserve_bytes,${M.MEMORY_IDENTITY_CORE_MAX_BYTES + reservation.bytes}),reserve_keys=max(reserve_keys,${reservation.keys}) WHERE space=${input.memorySpaceId} AND memory_id=${identity.memoryId}`,
          );
        }
        yield* stored(
          "checkpoint-publish",
          sql`INSERT INTO memory_compaction_state (space,checkpoint_id,boundary_json,retained_revision_boundary,published) VALUES (${input.memorySpaceId},${input.checkpointId},${yield* boundaryCodec.encode(last.causalBoundary)},${last.retentionFloor},1) ON CONFLICT(space) DO UPDATE SET checkpoint_id=excluded.checkpoint_id,boundary_json=excluded.boundary_json,retained_revision_boundary=excluded.retained_revision_boundary,published=1`,
        );
        const completed = yield* stored(
          "checkpoint-cursor",
          sql`UPDATE memory_sync_cursors SET after_sequence=${last.checkpointSequence},bootstrap_state='ready',snapshot_token=NULL,checkpoint_cursor=NULL,checkpoint_page_count=0 WHERE space=${input.memorySpaceId} AND hub_environment_id=${input.hubEnvironmentId} AND bootstrap_state='staging' AND snapshot_token=${input.expectedSnapshotToken} AND checkpoint_id=${input.checkpointId} AND checkpoint_sequence=${input.expectedCheckpointSequence} RETURNING space`,
        );
        if (completed.length !== 1)
          return yield* new MemoryStoreConflict({ code: "revision_changed" });
        yield* stored(
          "checkpoint-adopt-bodies",
          sql`UPDATE memory_payloads SET checkpoint_stage_id=NULL WHERE space=${input.memorySpaceId} AND checkpoint_stage_id=${input.checkpointId}`,
        );
        yield* stored(
          "checkpoint-finish",
          sql`DELETE FROM memory_inbox_pending WHERE space=${input.memorySpaceId} AND checkpoint_id=${input.checkpointId} AND record_kind='checkpoint'`,
        );
        yield* emit({
          memorySpaceId: input.memorySpaceId,
          projectionWatermark: checkpointWatermark,
          kind: "reset",
        });
      }),
    );
  });
  return {
    installCheckpointPage,
    completeCheckpoint,
  };
};

export type Checkpoints = ReturnType<typeof makeCheckpoints>;
