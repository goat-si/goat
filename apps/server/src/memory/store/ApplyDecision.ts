import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import type { Accounting } from "./Accounting.ts";
import type { CoreReads } from "./CoreReads.ts";
import type { ImportLineage } from "./ImportLineage.ts";
import type { ItemWrites } from "./ItemWrites.ts";
import type { RevertResults } from "./RevertResults.ts";
import {
  contentCodec,
  decodeOperation,
  decodeReceipt,
  exclusionsCodec,
  executionCodec,
  fenceCodec,
  headsCodec,
  identityCodec,
  lineageForRevision,
  metadataCodec,
  metadataOf,
  payloadCodec,
  provenanceCodec,
  receiptCodec,
  resolutionCodec,
  resolutionPayloadCodec,
  scopeCodec,
  selectionCodec,
  sourceKeysCodec,
  stored,
} from "./StoreCodecs.ts";
import type { StoreKernel } from "./StoreKernel.ts";
import {
  MemoryStoreConflict,
  hasSourceEvidence,
  resolutionReportId,
  sameHeadSet,
  strict,
} from "./StoreModel.ts";
import type { MemoryDecision } from "./StoreModel.ts";

export const makeApplyDecision = (
  kernel: Pick<StoreKernel, "emit" | "nextWatermark" | "sql" | "transact">,
  coreReads: Pick<
    CoreReads,
    "loadAggregate" | "operationFromMetadata" | "readAncestry" | "readItem" | "receipt"
  >,
  revertResults: Pick<RevertResults, "settleRevertResultTx">,
  itemWrites: Pick<ItemWrites, "enqueueWork" | "purge" | "putItem" | "writeSuppressions">,
  accounting: Pick<Accounting, "reservationForRevisions">,
  importLineage: Pick<ImportLineage, "settleImportOperationTx" | "unionImportLineageTx">,
) => {
  const { emit, nextWatermark, sql, transact } = kernel;
  const { loadAggregate, operationFromMetadata, readAncestry, readItem, receipt } = coreReads;
  const { settleRevertResultTx } = revertResults;
  const { enqueueWork, purge, putItem, writeSuppressions } = itemWrites;
  const { reservationForRevisions } = accounting;
  const { settleImportOperationTx, unionImportLineageTx } = importLineage;
  const applyDecision = Effect.fn("MemoryStore.applyDecision")(function* (
    decision: MemoryDecision,
    expectedGeneration?: number,
  ) {
    return yield* transact(
      Effect.gen(function* () {
        const op = yield* stored("operation-codec", decodeOperation(decision.operation, strict));
        // A hub append creates compact replay metadata before canonical incorporation.
        // Only an existing domain event can make a new hub admission a promotion.
        const eventRows =
          decision.admission.kind === "hubAdmission"
            ? yield* stored(
                "hub-domain-replay",
                sql<{
                  operation_digest: string;
                  receipt_json: string;
                }>`SELECT operation_digest,receipt_json FROM memory_events WHERE memory_space_id=${op.memorySpaceId} AND operation_id=${op.operationId}`,
              )
            : null;
        const old =
          eventRows === null
            ? yield* receipt(op.memorySpaceId, op.operationId)
            : eventRows[0]
              ? {
                  operationDigest: eventRows[0].operation_digest,
                  receipt: yield* receiptCodec.decode(eventRows[0].receipt_json, strict),
                }
              : undefined;
        if (old) {
          if (old.operationDigest !== decision.operationDigest)
            return yield* new MemoryStoreConflict({ code: "operation_id_reused" });
          if (expectedGeneration === undefined) {
            const promote =
              decision.admission.kind !== "localIntent" &&
              "hubSequence" in decision.receipt &&
              (!("hubSequence" in old.receipt) || old.receipt.hubSequence === null);
            if (!promote) return old;
            yield* stored(
              "receipt-promote",
              sql`UPDATE memory_events SET receipt_json=${yield* receiptCodec.encode({ ...decision.receipt, ...(old.receipt.forgetExpansion ? { forgetExpansion: old.receipt.forgetExpansion } : {}), ...(old.receipt.forgetRetryOf ? { forgetRetryOf: old.receipt.forgetRetryOf } : {}) })} WHERE memory_space_id=${op.memorySpaceId} AND operation_id=${op.operationId}`,
            );
          }
        } else if (expectedGeneration !== undefined) {
          return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
        }
        const reconnect = expectedGeneration !== undefined;
        if (reconnect) {
          if (
            decision.admission.kind !== "approvedReplica" ||
            op.kind === "forget" ||
            !old ||
            !("hubSequence" in old.receipt) ||
            old.receipt.hubSequence === null ||
            old.receipt.outcome === "rejected"
          )
            return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
          const pending = yield* stored(
            "reconnect-pending",
            sql<{
              operation_digest: string;
              metadata_json: string;
            }>`SELECT operation_digest,metadata_json FROM memory_inbox_pending WHERE space=${op.memorySpaceId} AND operation_id=${op.operationId} AND record_kind='operation'`,
          );
          // Completion and tombstone purge both remove the durable marker. Replay must not resurrect it.
          if (!pending[0]) return old;
          const canonical = yield* operationFromMetadata(
            yield* metadataCodec.decode(pending[0].metadata_json, strict),
          );
          if (
            pending[0].operation_digest !== decision.operationDigest ||
            !canonical ||
            M.encodeMemoryOperation(canonical) !== M.encodeMemoryOperation(op) ||
            (yield* receiptCodec.encode(old.receipt)) !==
              (yield* receiptCodec.encode(decision.receipt))
          )
            return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
          const current = yield* readItem(op.memorySpaceId, op.memoryId);
          if ((current?.generation ?? 0) !== expectedGeneration)
            return yield* new MemoryStoreConflict({ code: "revision_changed" });
          const ancestry = yield* readAncestry(op.memorySpaceId, op.memoryId, op.revision.parents);
          if (ancestry.parents.some((parent) => parent.status === "crossMemory"))
            return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
          if (
            !decision.pending &&
            ancestry.parents.some(
              (parent) => parent.status === "missing" || parent.status === "parked",
            )
          )
            return yield* new MemoryStoreConflict({ code: "missing_parent" });
          if (!decision.item) return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
        }
        const outcome = yield* stored(
          "receipt-codec",
          decodeReceipt(
            {
              ...decision.receipt,
              ...(old?.receipt.forgetExpansion
                ? { forgetExpansion: old.receipt.forgetExpansion }
                : {}),
              ...(old?.receipt.forgetRetryOf ? { forgetRetryOf: old.receipt.forgetRetryOf } : {}),
            },
            strict,
          ),
        );
        if (
          outcome.operationId !== op.operationId ||
          outcome.memoryId !== op.memoryId ||
          ("operationDigest" in outcome && outcome.operationDigest !== decision.operationDigest)
        )
          return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
        if (decision.admission.kind === "approvedReplica" && !("hubSequence" in outcome))
          return yield* new MemoryStoreConflict({ code: "unsupported_protocol" });
        const state = yield* readItem(op.memorySpaceId, op.memoryId);
        const tombstones = yield* stored(
          "tombstone-fence",
          sql`SELECT 1 FROM memory_tombstones WHERE space=${op.memorySpaceId} AND memory_id=${op.memoryId}`,
        );
        if (
          "hubSequence" in outcome &&
          !M.validateMemoryResolutionApproval(
            op.kind,
            op.kind === "resolve" ? op.resolution.resolutionId : null,
            outcome,
          )
        )
          return yield* new MemoryStoreConflict({ code: "unsupported_protocol" });
        const accepted = outcome.outcome !== "rejected";
        if (accepted && !decision.pending && !tombstones.length && op.kind !== "forget") {
          const r = op.revision;
          yield* stored(
            "replaced-payload",
            sql`UPDATE memory_payloads SET replaced_at=${Date.parse(r.createdAtUtc)},purge_eligible_after=${Date.parse(r.createdAtUtc) + M.MEMORY_REPLACED_PAYLOAD_RETENTION_MS} WHERE space=${op.memorySpaceId} AND memory_id=${op.memoryId} AND payload_ref!=${r.payloadRef} AND payload_ref IN (SELECT payload_ref FROM memory_revisions WHERE space=${op.memorySpaceId} AND revision_id IN (SELECT value FROM json_each(${yield* headsCodec.encode(r.parents)})))`,
          );
        }
        if (!reconnect && accepted && !tombstones.length && op.kind !== "forget") {
          const r = op.revision;
          const existing = yield* stored(
            "revision-identity",
            sql<{
              operation_id: string;
            }>`SELECT operation_id FROM memory_revisions WHERE space=${op.memorySpaceId} AND revision_id=${r.revisionId}`,
          );
          if (existing.length && existing[0]?.operation_id !== r.operationId)
            return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
          if (r.payloadRef !== r.revisionId) {
            const parent = yield* stored(
              "import-alias-parent",
              sql<{
                body_json: string;
                scope_json: string;
                assertion_kind: string;
              }>`SELECT p.body_json,v.scope_json,v.assertion_kind
              FROM memory_revisions v JOIN memory_payloads p ON p.space=v.space AND p.payload_ref=v.payload_ref
              WHERE v.space=${op.memorySpaceId} AND v.memory_id=${op.memoryId} AND v.revision_id=${r.parents[0] ?? null}
              AND v.payload_ref=${r.payloadRef} AND p.memory_id=${op.memoryId}`,
            );
            if (
              op.kind !== "upsert" ||
              !parent[0] ||
              parent[0].body_json !== (yield* payloadCodec.encode(op.payload)) ||
              parent[0].scope_json !== (yield* scopeCodec.encode(r.scope)) ||
              parent[0].assertion_kind !== r.assertionKind
            )
              return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
          }
          yield* stored(
            "payload",
            sql`INSERT INTO memory_payloads (space,payload_ref,memory_id,body_json,dependencies_json) VALUES (${op.memorySpaceId},${r.payloadRef},${op.memoryId},${yield* payloadCodec.encode(op.payload)},${yield* headsCodec.encode(op.payload.derivedFromMemoryRevisions)}) ON CONFLICT(space,payload_ref) DO NOTHING`,
          );
          yield* stored(
            "revision",
            sql`INSERT INTO memory_revisions (space,revision_id,memory_id,operation_id,parents_json,scope_json,assertion_kind,provenance_json,payload_ref,created_at) VALUES (${op.memorySpaceId},${r.revisionId},${op.memoryId},${r.operationId},${yield* headsCodec.encode(r.parents)},${yield* scopeCodec.encode(r.scope)},${r.assertionKind},${yield* provenanceCodec.encode(r.provenance)},${r.payloadRef},${Date.parse(r.createdAtUtc)}) ON CONFLICT(space,revision_id) DO NOTHING`,
          );
          if (op.kind === "resolve") {
            const resolution =
              "hubSequence" in outcome && outcome.resolutionApproval
                ? {
                    ...op.resolution,
                    appliedAtUtc: outcome.resolutionApproval.appliedAtUtc,
                    revertDeadlineUtc: outcome.resolutionApproval.revertDeadlineUtc,
                  }
                : op.resolution;
            const execution =
              decision.execution ??
              (decision.admission.kind === "approvedReplica"
                ? {
                    requestedModelSelection: resolution.requestedModelSelection,
                    effectiveProvider: resolution.effectiveProvider,
                    effectiveModel: resolution.effectiveModel,
                    providerInstanceId: resolution.requestedModelSelection.instanceId,
                    environmentId: resolution.resolvingEnvironmentId,
                  }
                : undefined);
            if (!execution) return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
            yield* stored(
              "judgment",
              sql`INSERT INTO memory_payloads (space,payload_ref,memory_id,body_json,dependencies_json,resolved_at,revert_deadline,purge_eligible_after) VALUES (${op.memorySpaceId},${resolution.judgmentRef},${op.memoryId},${yield* resolutionPayloadCodec.encode(op.resolutionPayload)},${yield* headsCodec.encode([...new Set([...resolution.inputRevisionIds, ...op.payload.derivedFromMemoryRevisions])])},${Date.parse(resolution.appliedAtUtc)},${Date.parse(resolution.revertDeadlineUtc)},${Date.parse(resolution.appliedAtUtc) + M.MEMORY_REPLACED_PAYLOAD_RETENTION_MS}) ON CONFLICT(space,payload_ref) DO NOTHING`,
            );
            yield* stored(
              "resolution",
              sql`INSERT INTO memory_resolutions (space,resolution_id,memory_id,input_revision_ids_json,input_payload_refs_json,judgment_payload_ref,requested_model_selection_json,effective_provider_model_json,resolving_environment_id,fencing_token,result_revision_id,applied_at,revert_deadline,resolution_json) VALUES (${op.memorySpaceId},${resolution.resolutionId},${op.memoryId},${yield* headsCodec.encode(resolution.inputRevisionIds)},${yield* headsCodec.encode(resolution.inputPayloadRefs)},${resolution.judgmentRef},${yield* selectionCodec.encode(resolution.requestedModelSelection)},${yield* executionCodec.encode(execution)},${resolution.resolvingEnvironmentId},${resolution.fencingToken},${resolution.resultRevisionId},${Date.parse(resolution.appliedAtUtc)},${Date.parse(resolution.revertDeadlineUtc)},${yield* resolutionCodec.encode(resolution)}) ON CONFLICT(space,resolution_id) DO NOTHING`,
            );
          }
        }
        const eventMetadata = yield* stored("metadata-codec", metadataCodec.encode(metadataOf(op)));
        const eventReceipt = yield* stored("receipt-codec", receiptCodec.encode(outcome));
        if (!reconnect && !old)
          yield* stored(
            "event",
            sql<{
              sequence: number;
            }>`INSERT INTO memory_events (protocol_version,memory_space_id,memory_id,operation_id,kind,origin_environment_id,operation_digest,metadata_json,receipt_json,created_at) VALUES (1,${op.memorySpaceId},${op.memoryId},${op.operationId},${op.kind},${op.originEnvironmentId},${decision.operationDigest},${eventMetadata},${eventReceipt},${op.kind === "forget" ? Date.parse(op.tombstone.deletedAtUtc) : Date.parse(op.revision.createdAtUtc)}) RETURNING sequence`,
          );
        const watermark = yield* nextWatermark(op.memorySpaceId);
        if (!reconnect && decision.identity) {
          const reservation =
            accepted && !tombstones.length && op.kind !== "forget"
              ? yield* reservationForRevisions(
                  op,
                  (yield* loadAggregate(
                    op.memorySpaceId,
                    op.memoryId,
                    { when: hasSourceEvidence },
                    {},
                  )).revisions,
                  false,
                )
              : { bytes: M.MEMORY_PAYLOAD_MAX_UTF8_BYTES, keys: 0 };
          yield* stored(
            "identity",
            sql`INSERT INTO memory_identity_ledger (space,memory_id,identity_json,fence_json,reserve_bytes,reserve_keys) VALUES (${op.memorySpaceId},${op.memoryId},${yield* identityCodec.encode(decision.identity)},${yield* fenceCodec.encode(decision.fence ?? { memorySpaceId: op.memorySpaceId, memoryId: op.memoryId, highestFencingToken: 0, activeLease: null })},${M.MEMORY_IDENTITY_CORE_MAX_BYTES + reservation.bytes},${reservation.keys}) ON CONFLICT(space,memory_id) DO UPDATE SET reserve_bytes=max(memory_identity_ledger.reserve_bytes,excluded.reserve_bytes),reserve_keys=max(memory_identity_ledger.reserve_keys,excluded.reserve_keys) WHERE NOT EXISTS (SELECT 1 FROM memory_tombstones t WHERE t.space=excluded.space AND t.memory_id=excluded.memory_id)`,
          );
        }
        if (
          accepted &&
          decision.admission.kind !== "localIntent" &&
          (decision.admission.kind === "approvedReplica" ||
            (!decision.pending && !tombstones.length)) &&
          op.kind !== "forget"
        ) {
          yield* unionImportLineageTx(lineageForRevision(op.revision), decision.admission);
        }
        if (accepted && op.kind === "forget") {
          const t = op.tombstone;
          yield* stored(
            "tombstone",
            sql`INSERT INTO memory_tombstones (space,memory_id,delete_operation_id,deleting_environment_id,deleted_at,suppressed_source_keys_json,suppressed_content_json,source_exclusions_json) VALUES (${op.memorySpaceId},${op.memoryId},${t.deleteOperationId},${t.deletingEnvironmentId},${Date.parse(t.deletedAtUtc)},${yield* sourceKeysCodec.encode(t.suppressedSourceKeys)},${yield* contentCodec.encode(t.suppressedContent)},${yield* exclusionsCodec.encode(t.sourceExclusions)}) ON CONFLICT(space,memory_id) DO NOTHING`,
          );
          yield* writeSuppressions(t);
          const item: M.MemoryItem = {
            memorySpaceId: op.memorySpaceId,
            memoryId: op.memoryId,
            status: "forgotten",
            tombstone: t,
            pendingSync: decision.admission.kind === "localIntent",
            localAvailability: {
              exposure: "forgotten",
              reasons: [],
              deferred: [],
              cleanupPending: false,
            },
          };
          yield* putItem(item, [], watermark);
          yield* purge(op.memorySpaceId, op.memoryId, watermark);
          yield* stored(
            "forget-reserve-consumed",
            sql`UPDATE memory_identity_ledger SET reserve_bytes=${M.MEMORY_IDENTITY_CORE_MAX_BYTES},reserve_keys=0 WHERE space=${op.memorySpaceId} AND memory_id=${op.memoryId}`,
          );
          yield* stored(
            "settle-forget",
            sql`DELETE FROM memory_pending_forget_intents WHERE space=${op.memorySpaceId} AND memory_id=${op.memoryId}`,
          );
        } else if (accepted && !tombstones.length && decision.item) {
          const projected =
            decision.admission.kind === "approvedReplica" && decision.item.status !== "forgotten"
              ? {
                  ...decision.item,
                  localAvailability: {
                    ...decision.item.localAvailability,
                    exposure: "held" as const,
                    reasons: [
                      ...new Set([
                        ...decision.item.localAvailability.reasons,
                        "scanner_pending" as const,
                      ]),
                    ],
                    deferred: [
                      ...decision.item.localAvailability.deferred.filter(
                        (d) => d.kind !== "scanner",
                      ),
                      {
                        kind: "scanner" as const,
                        state: "pending" as const,
                        reason: "scanner_pending" as const,
                        revisionId: op.kind !== "forget" ? op.revision.revisionId : null,
                        generation: 0,
                        sinceAtUtc:
                          op.kind !== "forget"
                            ? op.revision.createdAtUtc
                            : op.tombstone.deletedAtUtc,
                      },
                    ],
                  },
                }
              : decision.item;
          const held: M.MemoryItem =
            projected.status === "active" && projected.localAvailability.exposure === "held"
              ? {
                  memorySpaceId: op.memorySpaceId,
                  memoryId: op.memoryId,
                  status: "blocked",
                  scope: projected.scope,
                  pendingSync: projected.pendingSync,
                  failureCode: "scanner_pending",
                  localAvailability: projected.localAvailability,
                }
              : projected;
          yield* putItem(
            held,
            decision.heads ??
              (op.kind !== "forget" ? [op.revision.revisionId] : (state?.heads ?? [])),
            watermark,
          );
        }
        if (accepted && decision.conflict && !tombstones.length) {
          const c = decision.conflict;
          yield* stored(
            "conflict",
            sql`INSERT INTO memory_conflicts (space,conflict_id,memory_id,heads_json,status,failure_code) VALUES (${op.memorySpaceId},${c.conflictId},${op.memoryId},${yield* headsCodec.encode(c.heads)},${c.status},${c.failureCode ?? null}) ON CONFLICT(space,conflict_id) DO UPDATE SET heads_json=excluded.heads_json,status=excluded.status,failure_code=excluded.failure_code`,
          );
        }
        if (
          accepted &&
          !decision.pending &&
          !tombstones.length &&
          op.kind === "resolve" &&
          decision.heads?.length === 1 &&
          decision.heads[0] === op.revision.revisionId
        )
          yield* stored(
            "resolution-conflict-retire",
            sql`UPDATE memory_conflicts SET status='resolved',attempt_id=NULL,failure_code=NULL WHERE space=${op.memorySpaceId} AND memory_id=${op.memoryId} AND conflict_id=${op.conflictId} AND heads_json=${yield* headsCodec.encode(op.resolution.inputRevisionIds)}`,
          );
        if (accepted && decision.admission.kind === "localIntent")
          yield* enqueueWork({
            id: `sync:${op.memorySpaceId}:${op.operationId}`,
            space: op.memorySpaceId,
            memoryId: op.memoryId,
            kind: "sync",
            status: "pending",
            metadata: metadataOf(op),
            payloadRef: op.kind === "forget" ? null : op.revision.payloadRef,
            attempt: 0,
            nextAttemptAt: 0,
            claimedBy: null,
            claimedUntil: null,
          });
        if (
          !reconnect &&
          accepted &&
          decision.admission.kind === "localIntent" &&
          (op.kind === "resolve" || op.kind === "revert")
        ) {
          const resolutionId =
            op.kind === "resolve" ? op.resolution.resolutionId : op.revertsResolutionId;
          const reportId = resolutionReportId(op.memorySpaceId, op.operationId, resolutionId);
          yield* stored(
            "report-intent",
            sql`INSERT INTO memory_report_outbox (report_id,space,memory_id,operation_id,resolution_id,attempt_id,resolving_environment_id,outcome,state,created_at,report_kind,attempts_known) VALUES (${reportId},${op.memorySpaceId},${op.memoryId},${op.operationId},${resolutionId},${op.kind === "resolve" ? op.operationId : null},${op.originEnvironmentId},${op.kind === "resolve" ? "resolved" : "reverted"},'pending',${Date.parse(op.revision.createdAtUtc)},${op.kind === "resolve" ? "resolve" : "revert"},1) ON CONFLICT(report_id) DO NOTHING`,
          );
        }
        if (decision.pending && accepted && op.kind !== "forget" && !tombstones.length)
          yield* stored(
            "park-approved",
            sql`INSERT INTO memory_inbox_pending (space,pending_key,record_kind,operation_id,memory_id,operation_digest,missing_parents_json,reason,hub_sequence,metadata_json,payload_ref) VALUES (${op.memorySpaceId},${`operation:${op.operationId}`},'operation',${op.operationId},${op.memoryId},${decision.operationDigest},${yield* headsCodec.encode(decision.pending.missingParents)},${decision.pending.reason},${"hubSequence" in outcome ? outcome.hubSequence : null},${eventMetadata},${op.revision.payloadRef}) ON CONFLICT(space,pending_key) DO UPDATE SET missing_parents_json=excluded.missing_parents_json,reason=excluded.reason`,
          );
        if (op.kind === "revert" && "hubSequence" in outcome)
          yield* settleRevertResultTx(
            op.memorySpaceId,
            op.memoryId,
            op.revertsResolutionId,
            outcome,
            op.revision.revisionId,
          );
        if (accepted && op.kind === "revert")
          yield* stored(
            "accepted-revert-intent",
            sql`DELETE FROM memory_revert_intents WHERE space=${op.memorySpaceId} AND operation_id=${op.operationId}`,
          );
        if (reconnect && !decision.pending)
          yield* stored(
            "reconnect-complete",
            sql`DELETE FROM memory_inbox_pending WHERE space=${op.memorySpaceId} AND operation_id=${op.operationId} AND record_kind='operation'`,
          );
        if (
          accepted &&
          (op.kind === "forget" ||
            op.kind === "resolve" ||
            (decision.heads && !sameHeadSet(state?.heads ?? [], decision.heads)))
        ) {
          if (op.kind === "resolve")
            yield* stored(
              "resolution-canonical-fence",
              sql`UPDATE memory_identity_ledger SET fence_json=json_set(fence_json,'$.highestFencingToken',max(coalesce(json_extract(fence_json,'$.highestFencingToken'),0),${op.fencingToken}),'$.activeLease',NULL) WHERE space=${op.memorySpaceId} AND memory_id=${op.memoryId}`,
            );
          else
            yield* stored(
              "changed-heads-fence",
              sql`UPDATE memory_identity_ledger SET fence_json=json_set(fence_json,'$.activeLease',NULL) WHERE space=${op.memorySpaceId} AND memory_id=${op.memoryId}`,
            );
          const hubExists = yield* stored(
            "hub-fence-inventory",
            sql`SELECT 1 FROM sqlite_master WHERE name='memory_hub_leases'`,
          );
          if (hubExists.length)
            yield* stored(
              "changed-heads-hub-fence",
              sql`UPDATE memory_hub_leases SET lease_json=NULL WHERE space=${op.memorySpaceId} AND memory_id=${op.memoryId}`,
            );
        }
        for (const work of decision.work ?? []) yield* enqueueWork(work);
        if (accepted && (!tombstones.length || op.kind === "forget"))
          yield* emit({
            memorySpaceId: op.memorySpaceId,
            memoryId: op.memoryId,
            projectionWatermark: watermark,
            kind: op.kind === "forget" ? "forget" : "upsert",
          });
        for (const signal of decision.signals ?? [])
          yield* emit({ ...signal, projectionWatermark: watermark });
        if ("hubSequence" in outcome) yield* settleImportOperationTx(op.memorySpaceId, outcome);
        return { operationDigest: decision.operationDigest, receipt: outcome };
      }),
    );
  });
  const pendingReceived = Effect.fn("MemoryStore.pendingReceived")(function* (
    space: M.MemorySpaceId,
    limit: number,
  ) {
    const rows = yield* stored(
      "pending-received",
      sql<{
        metadata_json: string;
      }>`SELECT metadata_json FROM memory_inbox_pending WHERE space=${space} AND record_kind='operation' ORDER BY hub_sequence,pending_key LIMIT ${Math.min(limit, M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS)}`,
    );
    return yield* Effect.forEach(rows, (row) =>
      Effect.gen(function* () {
        return yield* operationFromMetadata(yield* metadataCodec.decode(row.metadata_json, strict));
      }),
    );
  });
  const readParked = Effect.fn("MemoryStore.readParked")(function* (limit: number) {
    const rows = yield* stored(
      "parked-recovery",
      sql<{
        metadata_json: string;
      }>`SELECT metadata_json FROM memory_inbox_pending WHERE record_kind='operation' AND hub_sequence IS NOT NULL ORDER BY hub_sequence,space,pending_key LIMIT ${Math.max(0, Math.min(limit, M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS))}`,
    );
    const result: M.MemoryOperation[] = [];
    for (const row of rows) {
      const operation = yield* operationFromMetadata(
        yield* metadataCodec.decode(row.metadata_json, strict),
      );
      if (operation) result.push(operation);
    }
    return result;
  });
  return {
    applyDecision,
    pendingReceived,
    readParked,
  };
};

export type ApplyDecision = ReturnType<typeof makeApplyDecision>;
