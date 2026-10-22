import { checkpointBound } from "./MemoryCheckpointBound.ts";
import { refreshCheckpointAccounting } from "./MemoryCheckpointAccounting.ts";
import {
  checkpointKeys,
  emptyCheckpointInventory,
  selectCheckpointMemory,
} from "./MemoryCheckpointInventory.ts";
import { scanMemoryValue } from "./MemorySecretScanner.ts";
import * as M from "@goat/contracts";
import { reportMetadataBytes } from "./MemoryReportAccounting.ts";
import * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import {
  adminActionCodec,
  adminCodec,
  adminReplayCodec,
  adminReplayJson,
  availabilityCodec,
  boundaryCodec,
  checkpointCodec,
  claimCodec,
  codec,
  compactCodec,
  decodeBinding,
  decodeCheckpoint,
  decodeFailureCode,
  decodeFailureEnvironment,
  decodeFtsState,
  decodeHoldClass,
  decodeLocalIntent,
  decodeMemoryId,
  decodeMemorySpaceId,
  decodeOperation,
  decodePendingForget,
  decodeReport,
  decodeTicket,
  deferredCodec,
  deferredRowCodec,
  executionCodec,
  fenceCodec,
  handleCodec,
  headsCodec,
  holdRearmResult,
  hubEntryCodec,
  hubReceiptCodec,
  identityCodec,
  keyCodec,
  lineageForRevision,
  localMetadataCodec,
  metadataCodec,
  metadataOf,
  payloadCodec,
  projectionCodec,
  provenanceCodec,
  pullRetryCodec,
  receiptCodec,
  resolutionCodec,
  resolutionPayloadCodec,
  rulesCodec,
  sampleCodec,
  scopeCodec,
  selectionCodec,
  snapshotId,
  stagedCheckpointCodec,
  stored,
  storedTicketRowCodec,
  stringArrayCodec,
  suppressionCodec,
  suppressionKeyCodec,
  threadCodec,
  threadHookCodec,
  threadLineageCodec,
  workMetadataCodec,
  workRows,
} from "./store/StoreCodecs.ts";
import type { WorkRow } from "./store/StoreCodecs.ts";
import {
  AdminRecordSchema,
  CheckpointTokenGuardSchema,
  HoldClass,
  HubAttemptReplay,
  LocalMemoryIntent,
  MemoryCapacityError,
  MemoryStorageError,
  MemoryStoreConflict,
  MemoryWork,
  PendingForgetIntent,
  TicketRowSchema,
  Transaction,
  emptyPullRetry,
  hasSourceEvidence,
  hashText,
  resolutionReportId,
  sameHeadSet,
  strict,
  threadHookId,
  threadLineageId,
} from "./store/StoreModel.ts";
import type {
  CheckpointStageIdentity,
  HubAuthority,
  HubCheckpointHandle,
  HubMember,
  IntentIdentityInput,
  MemoryDeferredWork,
  MemoryFtsState,
  MemoryHoldClass,
  SyncWorkCandidate,
  ThreadLineage,
  TicketKey,
  TicketOwner,
  TicketRow,
} from "./store/StoreModel.ts";
import type { MemoryStoreShape } from "./store/StoreShape.ts";
import { makeStoreKernel } from "./store/StoreKernel.ts";
import { makeCoreReads } from "./store/CoreReads.ts";
import { makeHistory } from "./store/History.ts";
import { makeRevertResults } from "./store/RevertResults.ts";
import { makeHubSnapshotReads } from "./store/HubSnapshotReads.ts";
import { makeItemWrites } from "./store/ItemWrites.ts";
import { makeAccounting } from "./store/Accounting.ts";
import { makeFtsIndex } from "./store/FtsIndex.ts";
import { makeImportLineage } from "./store/ImportLineage.ts";
import { makeImports } from "./store/Imports.ts";
import { makeApplyDecision } from "./store/ApplyDecision.ts";
import { makeSearch } from "./store/Search.ts";

export { decodeCompactReceipt, encodeCompactReceipt } from "./store/CompactReceipt.ts";
export { ImportCompletedNoopCodec, ImportNoopResultCodec } from "./store/StoreCodecs.ts";
export {
  LocalMemoryIntent,
  MemoryCapacityError,
  MemoryStorageError,
  MemoryStoreConflict,
  MemoryWork,
  PendingForgetIntent,
  StoredReceipt,
  approvedReplica,
  hasSourceEvidence,
  hubAdmission,
  localIntent,
  memorySuppressionRecords,
  resolutionReportId,
} from "./store/StoreModel.ts";
export type {
  AdminRecord,
  AdminReplay,
  AssignedIntent,
  HoldRearmPage,
  HubAuthority,
  HubCheckpointHandle,
  HubLedgerRecord,
  HubMember,
  HubRetention,
  HubUsage,
  InTx,
  IntentIdentityInput,
  MaterializedIntent,
  MemoryAdmissionContext,
  MemoryAggregate,
  MemoryAncestry,
  MemoryDecision,
  MemoryDeferredWork,
  MemoryFtsState,
  MemoryHistorySelection,
  MemoryHoldClass,
  MemoryIndexTarget,
  MemoryParentState,
  MemoryPayloadSelection,
  MemoryQuotaCharge,
  MemoryReadFilter,
  MemoryUsage,
  PersistedAdminAction,
  PullRetryState,
  ResolutionSnapshot,
  Settlement,
  SubmissionReconciliation,
  SyncWorkCandidate,
  SyncWorkOwner,
  TicketKey,
  TicketOwner,
  TicketRow,
  TicketState,
  Transaction,
  WorkHold,
} from "./store/StoreModel.ts";

export class MemoryStore extends Context.Service<MemoryStore, MemoryStoreShape>()(
  "goat/memory/MemoryStore",
) {}

const make = Effect.gen(function* () {
  const kernel = yield* makeStoreKernel;
  const {
    sql,
    wake,
    transact,
    withHubBudget,
    nextWatermark,
    emit,
    markRunnable,
    changes,
    counters,
    subscribeWake,
  } = kernel;
  const coreReads = makeCoreReads(kernel);
  const {
    receipt,
    readAncestry,
    readPending,
    readItem,
    readResolutionSnapshot,
    readResolutionHeads,
    loadAggregate,
    readImportLineage,
    readSuppressions,
    logicalBytes,
    readOperation,
    readWorkOperation,
  } = coreReads;
  const history = makeHistory(kernel, coreReads);
  const { readResolutionInputsPage, readAccess, historyPage } = history;
  const revertResults = makeRevertResults(kernel);
  const { recordRevertResultTx, settleRevertResultTx } = revertResults;
  const hubSnapshotReads = makeHubSnapshotReads(kernel);
  const { handlesFor, snapshotPages, snapshotBytes } = hubSnapshotReads;
  const itemWrites = makeItemWrites(kernel, coreReads, hubSnapshotReads);
  const { putItem, enqueueWork, purge, writeSuppressions } = itemWrites;
  const accounting = makeAccounting(kernel, coreReads, revertResults);
  const {
    reserve,
    settleForgetExpansion,
    readForgetReservation,
    reservationForRevisions,
    firstForgetReservation,
    usage,
    persistCompactReceipt,
  } = accounting;
  const ftsIndex = makeFtsIndex(kernel, coreReads);
  const { index } = ftsIndex;
  const importLineage = makeImportLineage(kernel, coreReads, accounting);
  const {
    settleImportOperationTx,
    retireImportBatchesTx,
    requireImportLineageCompleteTx,
    persistImportLineageTx,
    unionImportLineageTx,
  } = importLineage;
  const imports = makeImports(kernel, coreReads, importLineage);
  const {
    readImportRegistrationTx,
    writeImportRegistrationTx,
    readImportBatchTx,
    readImportReceiptTx,
    readImportItemTx,
    commitImportItemTx,
    findImportMatchTx,
  } = imports;
  const applyDecisionModule = makeApplyDecision(
    kernel,
    coreReads,
    revertResults,
    itemWrites,
    accounting,
    importLineage,
  );
  const { applyDecision, pendingReceived, readParked } = applyDecisionModule;
  const searchModule = makeSearch(kernel, coreReads);
  const { readCursor, withReceivedCursor, list, searchCoverage, search } = searchModule;

  const readWork = Effect.fn("MemoryStore.readWork")(function* (id: string) {
    const rows = yield* stored(
      "read-work",
      sql<WorkRow>`SELECT * FROM memory_outbox WHERE id=${id} AND admin_json IS NULL`,
    );
    return (yield* workRows(rows))[0];
  });
  const readThreadLineage = Effect.fn("MemoryStore.readThreadLineage")(function* (
    thread: M.ScopedThreadRef,
    space: M.MemorySpaceId,
  ) {
    const rows = yield* stored(
      "thread-lineage-read",
      sql<{ metadata_json: string }>`
      SELECT metadata_json FROM memory_outbox WHERE id=${threadLineageId(thread)}`,
    );
    const lineage: ThreadLineage = rows[0]
      ? yield* threadLineageCodec
          .decode(rows[0].metadata_json, strict)
          .pipe(
            Effect.mapError(
              (cause) => new MemoryStorageError({ stage: "thread-lineage-codec", cause }),
            ),
          )
      : {
          kind: "threadLineage",
          sourceThread: thread,
          memorySpaceId: space,
          state: "tracked",
          revisions: [],
        };
    // App-owned delegation sends a task, not parent history; its node/spawn links
    // alone do not fence writes. Provider-native children cannot prove non-inheritance.
    // An active provider pointer alone also says nothing about inherited context.
    // Same-thread handoffs/compaction keep the cumulative set; rollback cannot clear it.
    const unknown = yield* stored(
      "thread-lineage-origin",
      sql`SELECT 1 FROM orchestration_events
      WHERE application_event_version=2 AND aggregate_kind='thread' AND stream_id=${thread.threadId}
      AND ((event_type='thread.created' AND (
        json_extract(payload_json,'$.forkedFrom.type') IN ('run','provider_thread')
        OR json_extract(payload_json,'$.lineage.relationshipToParent')='fork'
        OR json_extract(payload_json,'$.historyOrigin')='v1_import'
        OR (json_extract(payload_json,'$.creationSource')='provider' AND (
          json_extract(payload_json,'$.lineage.relationshipToParent')='subagent'
          OR json_extract(payload_json,'$.forkedFrom.type')='node'
          OR json_extract(payload_json,'$.lineage.parentThreadId') IS NOT NULL))))
        OR (event_type='provider-thread.updated' AND json_extract(payload_json,'$.forkedFrom.providerThreadId') IS NOT NULL)
        OR (event_type='provider-thread.updated' AND json_extract(payload_json,'$.status')='not_loaded' AND json_extract(payload_json,'$.nativeThreadRef') IS NOT NULL AND json_extract(payload_json,'$.providerSessionId') IS NULL)
        OR (event_type IN ('context-transfer.created','context-transfer.updated')
          AND json_extract(payload_json,'$.type') IS NOT 'subagent_spawn'
          AND json_extract(payload_json,'$.targetThreadId')=${thread.threadId}
          AND json_extract(payload_json,'$.sourceThreadId')!=${thread.threadId})) LIMIT 1`,
    );
    return lineage.memorySpaceId !== space || unknown.length
      ? { ...lineage, state: "unknown" as const }
      : lineage;
  });
  const appendThreadLineage = Effect.fn("MemoryStore.appendThreadLineage")(function* (
    thread: M.ScopedThreadRef,
    space: M.MemorySpaceId,
    revisions: ReadonlyArray<M.MemoryRevisionId>,
  ) {
    return yield* transact(
      Effect.gen(function* () {
        const previous = yield* readThreadLineage(thread, space);
        const union = [...new Set([...previous.revisions, ...revisions])];
        const state =
          previous.state !== "tracked"
            ? previous.state
            : union.length > 100
              ? "overflow"
              : "tracked";
        // Injection remains available for unknown/overflow contexts. Persist the fence
        // before delivery so every thread-derived producer stays disabled thereafter.
        // Overflow preserves the previous set, including an initially empty set.
        const metadata = yield* stored(
          "thread-lineage-codec",
          threadLineageCodec.encode({
            ...previous,
            state,
            revisions: union.length > 100 ? previous.revisions : union,
          }),
        );
        yield* stored(
          "thread-lineage-write",
          sql`INSERT INTO memory_outbox
        (id,space,kind,status,metadata_json,next_attempt_at)
        VALUES (${threadLineageId(thread)},'_worker','rebuild','completed',${metadata},0)
        ON CONFLICT(id) DO UPDATE SET metadata_json=excluded.metadata_json
        WHERE memory_outbox.metadata_json!=excluded.metadata_json`,
        );
        return true;
      }),
    );
  });
  const deleteThreadLineage = Effect.fn("MemoryStore.deleteThreadLineage")(function* (
    thread: M.ScopedThreadRef,
  ) {
    yield* stored(
      "thread-lineage-delete",
      sql`DELETE FROM memory_outbox WHERE id=${threadLineageId(thread)}`,
    );
  });
  const retryWork = Effect.fn("MemoryStore.retryWork")(function* (
    work: MemoryWork,
    nextAttemptAt: number,
  ) {
    if (work.status !== "running" || work.claimedBy === null || work.claimedUntil === null)
      return false;
    const rows = yield* stored(
      "retry-work",
      sql`UPDATE memory_outbox SET status='retry',next_attempt_at=${nextAttemptAt},claimed_by=NULL,claimed_until=NULL WHERE id=${work.id} AND kind NOT IN ('claim','resolve','revert_intent') AND status='running' AND claimed_by=${work.claimedBy} AND claimed_until=${work.claimedUntil} AND attempt=${work.attempt} RETURNING id`,
    );
    return rows.length === 1;
  });
  const rearmGenerationWork = Effect.fn("MemoryStore.rearmGenerationWork")(function* (now: number) {
    const rows = yield* stored(
      "rearm-generation-work",
      sql`UPDATE memory_outbox SET next_attempt_at=${now} WHERE kind IN ('summary','consolidate') AND status='retry' AND next_attempt_at>${now} RETURNING id`,
    );
    return rows.length;
  });
  const renewWork = Effect.fn("MemoryStore.renewWork")(function* (
    work: MemoryWork,
    now: number,
    until: number,
  ) {
    if (work.status !== "running" || work.claimedBy === null || work.claimedUntil === null)
      return undefined;
    const rows = yield* stored(
      "renew-work",
      sql`UPDATE memory_outbox SET claimed_until=${until} WHERE id=${work.id} AND kind IN ('summary','consolidate','rebuild') AND status='running' AND claimed_by=${work.claimedBy} AND claimed_until=${work.claimedUntil} AND attempt=${work.attempt} AND claimed_until>${now} RETURNING id`,
    );
    return rows.length === 1 ? { ...work, claimedUntil: until } : undefined;
  });
  const rebindWorkModel = Effect.fn("MemoryStore.rebindWorkModel")(function* (
    work: MemoryWork,
    modelSelection: M.MemoryModelSelection,
  ) {
    if (
      work.metadata.kind !== "summary" ||
      work.status !== "running" ||
      work.claimedBy === null ||
      work.claimedUntil === null
    )
      return undefined;
    const metadata = { ...work.metadata, modelSelection };
    const rows = yield* stored(
      "rebind-work-model",
      sql`UPDATE memory_outbox SET metadata_json=${yield* workMetadataCodec.encode(metadata)} WHERE id=${work.id} AND kind IN ('summary','consolidate') AND status='running' AND claimed_by=${work.claimedBy} AND claimed_until=${work.claimedUntil} AND attempt=${work.attempt} RETURNING id`,
    );
    return rows.length === 1 ? { ...work, metadata } : undefined;
  });
  const cancelThreadWork = Effect.fn("MemoryStore.cancelThreadWork")(function* (
    input: M.ScopedThreadRef,
  ) {
    const thread = yield* threadCodec.decode(yield* threadCodec.encode(input), strict);
    const rows = yield* stored(
      "cancel-thread-work",
      sql`UPDATE memory_outbox SET status='cancelled',payload_ref=NULL,claimed_by=NULL,claimed_until=NULL WHERE kind IN ('summary','consolidate') AND status IN ('pending','running','retry') AND json_extract(metadata_json,'$.kind')='summary' AND json_extract(metadata_json,'$.sourceThread.environmentId')=${thread.environmentId} AND json_extract(metadata_json,'$.sourceThread.threadId')=${thread.threadId} RETURNING id`,
    );
    return rows.length;
  });
  const readThreadHookWatermark = Effect.fn("MemoryStore.readThreadHookWatermark")(function* () {
    const rows = yield* stored(
      "thread-hook-read",
      sql<{
        metadata_json: string;
      }>`SELECT metadata_json FROM memory_outbox WHERE id=${threadHookId}`,
    );
    return rows[0] ? (yield* threadHookCodec.decode(rows[0].metadata_json, strict)).watermark : 0;
  });
  const commitThreadHook = Effect.fn("MemoryStore.commitThreadHook")(function* (input: {
    expectedWatermark: number;
    throughWatermark: number;
    work: ReadonlyArray<MemoryWork>;
  }) {
    yield* transact(
      Effect.gen(function* () {
        const metadata = yield* threadHookCodec.encode({
          kind: "threadHook",
          watermark: input.throughWatermark,
        });
        if (
          input.throughWatermark < input.expectedWatermark ||
          (yield* readThreadHookWatermark()) !== input.expectedWatermark
        )
          return yield* new MemoryStoreConflict({ code: "revision_changed" });
        if (input.work.some((work) => work.id === threadHookId))
          return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
        for (const work of input.work) yield* enqueueWork(work);
        // Completed marker is never runnable; no transcript is retained in hook metadata.
        yield* stored(
          "thread-hook-commit",
          sql`INSERT INTO memory_outbox (id,space,kind,status,metadata_json,next_attempt_at) VALUES (${threadHookId},'_worker','rebuild','completed',${metadata},0) ON CONFLICT(id) DO UPDATE SET metadata_json=excluded.metadata_json`,
        );
      }),
    );
  });
  const dueWork = Effect.fn("MemoryStore.dueWork")(function* (
    now: number,
    limit: number,
    kinds: ReadonlyArray<"summary" | "consolidate" | "rebuild"> = [
      "summary",
      "consolidate",
      "rebuild",
    ],
  ) {
    // Filter before the limit so skipped kinds cannot fill every page.
    if (!kinds.length) return [];
    const rows = yield* stored(
      "due-work",
      sql<WorkRow>`SELECT * FROM memory_outbox WHERE kind IN ${sql.in(kinds)} AND (status IN ('pending','retry') OR (status='running' AND claimed_until<=${now})) AND next_attempt_at<=${now} ORDER BY next_attempt_at,attempt,id LIMIT ${Math.max(0, Math.min(limit, M.MEMORY_PAGE_MAX_ITEMS))}`,
    );
    return yield* workRows(rows);
  });
  const claimWork = Effect.fn("MemoryStore.claimWork")(function* (
    id: string,
    owner: string,
    now: number,
    until: number,
  ) {
    const rows = yield* stored(
      "claim-work",
      sql`UPDATE memory_outbox SET status='running',claimed_by=${owner},claimed_until=${until},attempt=min(attempt+1,2147483647) WHERE id=${id} AND kind NOT IN ('claim','resolve','revert_intent') AND next_attempt_at<=${now} AND (status IN ('pending','retry') OR (status='running' AND claimed_until<=${now})) RETURNING id`,
    );
    return rows.length === 1;
  });
  const clearTerminalSubmission = Effect.fnUntraced(function* (id: string) {
    const rows = yield* stored(
      "terminal-submission",
      sql<{
        space: string;
        ticket_json: string;
      }>`SELECT space,ticket_json FROM memory_outbox WHERE id=${id} AND kind='resolve' AND ticket_json IS NOT NULL`,
    );
    if (!rows[0]) return;
    const row = yield* stored(
      "terminal-ticket",
      storedTicketRowCodec.decode(rows[0].ticket_json, strict),
    );
    yield* stored(
      "terminal-submission-purge",
      sql`DELETE FROM memory_payloads WHERE space=${rows[0].space} AND payload_ref=${`submission:${row.ticket.attemptId}`}`,
    );
    yield* stored(
      "terminal-ticket-fence",
      sql`UPDATE memory_outbox SET ticket_json=${yield* storedTicketRowCodec.encode({ ...row, state: "terminal", version: row.version + 1, submission: null, submissionDigest: null, owner: null, ownedUntil: null })},sync_version=sync_version+1,payload_ref=NULL WHERE id=${id}`,
    );
  });
  const finishWork = Effect.fn("MemoryStore.finishWork")(function* (
    id: string,
    status: "completed" | "cancelled" | "failed",
    result?: M.MemoryHubReceipt,
  ) {
    yield* transact(
      Effect.gen(function* () {
        yield* clearTerminalSubmission(id);
        yield* stored(
          "finish-work",
          sql`UPDATE memory_outbox SET status=${status},terminal_at=${yield* Clock.currentTimeMillis},claimed_by=NULL,claimed_until=NULL,completed_receipt_json=${result ? yield* receiptCodec.encode(result) : null},payload_ref=NULL WHERE id=${id}`,
        );
      }),
    );
  });
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
  const scannerPayloadCodec = codec(Schema.Union([M.MemoryPayload, M.MemoryResolutionPayload]));
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
  const getProjectBinding = Effect.fn("MemoryStore.getProjectBinding")(function* (
    space: M.MemorySpaceId,
    project: M.ScopedProjectRef,
  ) {
    const rows = yield* stored(
      "binding",
      sql<{
        project_key_json: string | null;
        repository_key_json: string | null;
        version: number;
      }>`SELECT * FROM memory_project_bindings WHERE memory_space_id=${space} AND environment_id=${project.environmentId} AND project_id=${project.projectId}`,
    );
    const row = rows[0];
    return row
      ? yield* stored(
          "binding-codec",
          Effect.gen(function* () {
            return yield* decodeBinding(
              {
                memorySpaceId: space,
                project,
                projectKey: row.project_key_json
                  ? yield* keyCodec.decode(row.project_key_json, strict)
                  : null,
                repositoryKey: row.repository_key_json
                  ? yield* keyCodec.decode(row.repository_key_json, strict)
                  : null,
                version: row.version,
              },
              strict,
            );
          }),
        )
      : undefined;
  });
  const putProjectBinding = Effect.fn("MemoryStore.putProjectBinding")(function* (
    input: M.MemoryProjectBinding,
    expected: number | null,
    now: number,
  ) {
    return yield* transact(
      Effect.gen(function* () {
        const binding = yield* stored("binding-codec", decodeBinding(input, strict));
        const old = yield* getProjectBinding(binding.memorySpaceId, binding.project);
        if ((old?.version ?? null) !== expected)
          return yield* new MemoryStoreConflict({ code: "revision_changed" });
        yield* stored(
          "binding-write",
          sql`INSERT INTO memory_project_bindings (memory_space_id,environment_id,project_id,project_key_json,repository_key_json,version,updated_at) VALUES (${binding.memorySpaceId},${binding.project.environmentId},${binding.project.projectId},${binding.projectKey ? yield* keyCodec.encode(binding.projectKey) : null},${binding.repositoryKey ? yield* keyCodec.encode(binding.repositoryKey) : null},${binding.version},${now}) ON CONFLICT(memory_space_id,environment_id,project_id) DO UPDATE SET project_key_json=excluded.project_key_json,repository_key_json=coalesce(memory_project_bindings.repository_key_json,excluded.repository_key_json),version=excluded.version,updated_at=excluded.updated_at`,
        );

        yield* emit({
          memorySpaceId: binding.memorySpaceId,
          projectionWatermark: yield* nextWatermark(binding.memorySpaceId),
          kind: "reset",
        });
      }),
    );
  });
  const ftsState = Effect.fn("MemoryStore.ftsState")(function* (environment: M.EnvironmentId) {
    const rows = yield* stored(
      "fts-state",
      sql<{
        state: "open" | "braked";
        changed_at: number | null;
        allocated_bytes: number | null;
        measured_at: number | null;
        measurement_status: "available" | "unavailable";
        merge_pending: number;
        changed_rows: number;
        last_merge_at: number | null;
      }>`SELECT * FROM memory_fts_maintenance_state WHERE environment=${environment}`,
    );
    const row = rows[0];
    return row
      ? {
          environment,
          state: row.state,
          changedAt: row.changed_at,
          allocatedBytes: row.allocated_bytes,
          measuredAt: row.measured_at,
          measurementStatus: row.measurement_status,
          mergePending: row.merge_pending === 1,
          changedRows: row.changed_rows,
          lastMergeAt: row.last_merge_at,
        }
      : {
          environment,
          state: "open" as const,
          changedAt: null,
          allocatedBytes: null,
          measuredAt: null,
          measurementStatus: "unavailable" as const,
          mergePending: false,
          changedRows: 0,
          lastMergeAt: null,
        };
  });
  const putFtsState = Effect.fn("MemoryStore.putFtsState")(function* (input: MemoryFtsState) {
    const state = yield* stored("fts-state-codec", decodeFtsState(input, strict));
    yield* stored(
      "fts-state-write",
      sql`INSERT INTO memory_fts_maintenance_state (environment,state,changed_at,allocated_bytes,measured_at,measurement_status,merge_pending,changed_rows,last_merge_at) VALUES (${state.environment},${state.state},${state.changedAt},${state.allocatedBytes},${state.measuredAt},${state.measurementStatus},${state.mergePending ? 1 : 0},${state.changedRows},${state.lastMergeAt}) ON CONFLICT(environment) DO UPDATE SET state=excluded.state,changed_at=excluded.changed_at,allocated_bytes=excluded.allocated_bytes,measured_at=excluded.measured_at,measurement_status=excluded.measurement_status,merge_pending=excluded.merge_pending,changed_rows=excluded.changed_rows,last_merge_at=excluded.last_merge_at`,
    );
  });
  const measureAllocation = Effect.fn("MemoryStore.measureAllocation")(function* () {
    const pages = yield* stored("page-count", sql<{ page_count: number }>`PRAGMA page_count`);
    const size = yield* stored("page-size", sql<{ page_size: number }>`PRAGMA page_size`);
    const free = yield* stored("freelist", sql<{ freelist_count: number }>`PRAGMA freelist_count`);
    // The name constraint lets dbstat walk only memory btrees. Unfiltered, it reads every
    // page of the shared database, which takes seconds once orchestration history is large.
    const tableAllocations = yield* sql<{
      name: string;
      bytes: number;
    }>`SELECT name,sum(pgsize) AS bytes FROM dbstat WHERE name IN (SELECT name FROM sqlite_master WHERE (type='table' AND name LIKE 'memory_%') OR (type='index' AND tbl_name LIKE 'memory_%')) GROUP BY name`.pipe(
      Effect.option,
    );
    const allocation = Option.isSome(tableAllocations)
      ? {
          memory_bytes: tableAllocations.value.reduce((sum, row) => sum + row.bytes, 0),
          fts_bytes: tableAllocations.value
            .filter((row) => row.name.startsWith("memory_items_fts"))
            .reduce((sum, row) => sum + row.bytes, 0),
        }
      : undefined;
    const tables: M.MemoryStorageTableUsage[] = [];
    for (const table of M.MemoryStorageTable.literals) {
      const exists = yield* stored(
        "table-inventory",
        sql`SELECT 1 FROM sqlite_master WHERE name=${table} AND type='table'`,
      );
      if (!exists.length) continue;
      const rows = yield* stored(
        "table-count",
        sql.unsafe<{ count: number }>(`SELECT count(*) AS count FROM ${table}`),
      );
      const indexedNames = yield* stored(
        "table-indexes",
        sql<{
          name: string;
        }>`SELECT name FROM sqlite_master WHERE tbl_name=${table} AND type='index'`,
      );
      const names = new Set([
        table,
        ...indexedNames.map((row) => row.name),
        ...(table === "memory_items_fts"
          ? [
              "memory_items_fts_data",
              "memory_items_fts_idx",
              "memory_items_fts_content",
              "memory_items_fts_docsize",
              "memory_items_fts_config",
            ]
          : []),
      ]);
      const allocated = Option.isSome(tableAllocations)
        ? tableAllocations.value
            .filter((row) => names.has(row.name))
            .reduce((sum, row) => sum + row.bytes, 0)
        : null;
      const columns = yield* stored(
        "table-columns",
        sql.unsafe<{ name: string }>(`PRAGMA table_info(${table})`),
      );
      const charged = columns.filter(
        (column) =>
          column.name.endsWith("_json") ||
          column.name === "reserve_bytes" ||
          (table === "memory_items_fts" && column.name === "body"),
      );
      const expression =
        charged
          .map((column) =>
            column.name === "reserve_bytes"
              ? "coalesce(reserve_bytes,0)"
              : `coalesce(length(CAST("${column.name.replaceAll('"', '""')}" AS BLOB)),0)`,
          )
          .join("+") || "0";
      const logical = yield* stored(
        "table-logical",
        sql.unsafe<{ bytes: number }>(
          `SELECT coalesce(sum(${expression}),0) AS bytes FROM ${table}`,
        ),
      );
      tables.push({
        table,
        rowCount: rows[0]!.count,
        logicalBytes: logical[0]!.bytes,
        allocatedBytes: allocated,
        allocationStatus: allocated === null ? "unavailable" : "available",
      });
    }
    return {
      tables,
      memoryBytes: allocation?.memory_bytes ?? null,
      ftsBytes: allocation?.fts_bytes ?? null,
      dbFileBytes: (pages[0]?.page_count ?? 0) * (size[0]?.page_size ?? 0),
      freelistBytes: (free[0]?.freelist_count ?? 0) * (size[0]?.page_size ?? 0),
    };
  });
  const mergeFts = Effect.fn("MemoryStore.mergeFts")(function* () {
    return yield* sql`INSERT INTO memory_items_fts(memory_items_fts,rank) VALUES ('merge',${M.MEMORY_FTS_MERGE_MAX_PAGES})`.pipe(
      Effect.as(true),
      Effect.catch(() => Effect.succeed(false)),
    );
  });
  const measuredMemoryBytes = Effect.fn("MemoryStore.measuredMemoryBytes")(function* (
    environment: M.EnvironmentId,
  ) {
    const rows = yield* stored(
      "sample-memory-bytes",
      sql<{
        bytes: number | null;
      }>`SELECT json_extract(current_sample_json,'$.memoryAllocatedBytes') AS bytes FROM memory_compaction_state WHERE space=${`_environment:${environment}`}`,
    );
    return rows[0]?.bytes ?? null;
  });
  // Completion already keeps one completed row per thread and kind. What remains are rows
  // for threads that are gone and cancelled or failed rows behind a newer run. The recovery
  // scan reads only each live thread's newest row, so neither can matter again. A page holds
  // a fixed number of outbox rows, so one call costs the same on any backlog.
  const pruneSettledSummaryWork = Effect.fn("MemoryStore.pruneSettledSummaryWork")(function* (
    environment: M.EnvironmentId,
    afterRowId: number,
    pageRows: number,
  ) {
    const page = yield* stored(
      "summary-work-page",
      sql<{
        last: number | null;
        rows: number;
      }>`SELECT max(rowid) AS last,count(*) AS rows FROM (SELECT rowid FROM memory_outbox WHERE rowid>${afterRowId} ORDER BY rowid LIMIT ${Math.max(1, pageRows)})`,
    );
    const last = page[0]?.last ?? null;
    if (last === null) return { removed: 0, nextRowId: null };
    const removed = yield* stored(
      "summary-work-prune",
      sql<{ id: string }>`DELETE FROM memory_outbox WHERE rowid IN (
        SELECT o.rowid FROM memory_outbox o NOT INDEXED
        WHERE o.rowid>${afterRowId} AND o.rowid<=${last} AND o.kind IN ('summary','consolidate')
        AND o.status IN ('completed','cancelled','failed') AND json_extract(o.metadata_json,'$.kind')='summary'
        AND json_extract(o.metadata_json,'$.sourceThread.environmentId')=${environment}
        AND (
          NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_threads t WHERE t.thread_id=json_extract(o.metadata_json,'$.sourceThread.threadId') AND t.deleted_at IS NULL)
          OR (o.status IN ('cancelled','failed') AND EXISTS (
            SELECT 1 FROM memory_outbox n WHERE n.kind IN ('summary','consolidate')
            AND json_extract(n.metadata_json,'$.sourceThread.threadId')=json_extract(o.metadata_json,'$.sourceThread.threadId')
            AND coalesce(json_extract(n.metadata_json,'$.observedThroughSequence'),json_extract(n.metadata_json,'$.sourceWatermark.throughSequence'))
              >coalesce(json_extract(o.metadata_json,'$.observedThroughSequence'),json_extract(o.metadata_json,'$.sourceWatermark.throughSequence'))))
        )
      ) RETURNING id`,
    );
    return {
      removed: removed.length,
      nextRowId: (page[0]?.rows ?? 0) < Math.max(1, pageRows) ? null : last,
    };
  });
  const recordSample = Effect.fn("MemoryStore.recordSample")(function* (
    environment: M.EnvironmentId,
    input: M.MemoryStorageSample,
  ) {
    return yield* transact(
      Effect.gen(function* () {
        const json = yield* sampleCodec.encode(input);
        const systemSpace = `_environment:${environment}`;
        const rows = yield* stored(
          "sample-current",
          sql<{
            current_sample_json: string | null;
          }>`SELECT current_sample_json FROM memory_compaction_state WHERE space=${systemSpace}`,
        );
        const previous = rows[0]?.current_sample_json
          ? yield* sampleCodec.decode(rows[0].current_sample_json, strict)
          : undefined;
        if (previous && Date.parse(previous.measuredAtUtc) >= Date.parse(input.measuredAtUtc))
          return false;
        if (previous && previous.utcDay !== input.utcDay)
          yield* stored(
            "sample-archive",
            sql`INSERT INTO memory_storage_samples (environment,utc_day,measured_at,sample_json,is_current) VALUES (${environment},${previous.utcDay},${Date.parse(previous.measuredAtUtc)},${yield* sampleCodec.encode(previous)},0) ON CONFLICT(environment,utc_day) DO UPDATE SET measured_at=excluded.measured_at,sample_json=excluded.sample_json`,
          );
        yield* stored(
          "sample-current-write",
          sql`INSERT INTO memory_compaction_state (space,current_sample_json) VALUES (${systemSpace},${json}) ON CONFLICT(space) DO UPDATE SET current_sample_json=excluded.current_sample_json`,
        );
        yield* stored(
          "sample-evict",
          sql`DELETE FROM memory_storage_samples WHERE environment=${environment} AND utc_day NOT IN (SELECT utc_day FROM memory_storage_samples WHERE environment=${environment} ORDER BY utc_day DESC LIMIT ${M.MEMORY_STORAGE_SAMPLE_MAX_DAYS})`,
        );
        return true;
      }),
    );
  });
  const samples = Effect.fn("MemoryStore.samples")(function* (environment: M.EnvironmentId) {
    const rows = yield* stored(
      "samples",
      sql<{
        sample_json: string;
      }>`SELECT sample_json FROM memory_storage_samples WHERE environment=${environment} UNION ALL SELECT current_sample_json AS sample_json FROM memory_compaction_state WHERE space=${`_environment:${environment}`} AND current_sample_json IS NOT NULL`,
    );
    const result = yield* Effect.forEach(rows, (row) =>
      sampleCodec.decode(row.sample_json, strict),
    );
    return result.toSorted((a, b) => a.utcDay.localeCompare(b.utcDay));
  });
  const unresolvedSubmission = (
    space: string | ReturnType<typeof sql.unsafe>,
    memoryId: string | ReturnType<typeof sql.unsafe>,
  ) => sql`EXISTS (
    SELECT 1 FROM memory_outbox r WHERE r.space=${space} AND r.memory_id=${memoryId}
    AND r.kind='resolve' AND r.status IN ('pending','retry','running')
    AND (json_extract(r.ticket_json,'$.submission') IS NOT NULL
      OR json_extract(r.ticket_json,'$.approval.outcome') != 'rejected') LIMIT 1
  )`;
  const readDueClaimCandidates = Effect.fn("MemoryStore.readDueClaimCandidates")(function* (
    limit: number,
    now: number,
    memorySpaceId: M.MemorySpaceId,
  ) {
    return yield* workRows(
      yield* stored(
        "claim-candidates",
        sql<WorkRow>`SELECT o.* FROM memory_outbox o JOIN memory_items i ON i.space=o.space AND i.memory_id=o.memory_id WHERE o.space=${memorySpaceId} AND o.kind='claim' AND o.status IN ('pending','retry') AND o.next_attempt_at<=${now} AND i.status='quarantined' AND NOT ${unresolvedSubmission(sql.unsafe("o.space"), sql.unsafe("o.memory_id"))} AND NOT EXISTS (SELECT 1 FROM memory_pending_forget_intents f WHERE f.space=i.space AND f.memory_id=i.memory_id) AND NOT EXISTS (SELECT 1 FROM json_each(i.availability_json,'$.reasons') r WHERE r.value IN ('scanner_pending','secret_detected','missing_parent','dependency_invalidated','forget_pending')) ORDER BY o.next_attempt_at,o.id LIMIT ${Math.max(0, Math.min(limit, M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS))}`,
      ),
    );
  });
  const findClaimCandidate: MemoryStore["Service"]["findClaimCandidate"] = Effect.fn(
    "MemoryStore.findClaimCandidate",
  )(function* (input) {
    let candidateId = input.candidateId;
    if (candidateId === undefined) {
      const tickets = yield* stored(
        "claim-ticket-key",
        sql<{
          ticket_json: string | null;
        }>`SELECT ticket_json FROM memory_outbox WHERE id=${`resolve:${input.memorySpaceId}:${input.attemptId}`} AND space=${input.memorySpaceId}`,
      );
      if (!tickets[0]?.ticket_json) return null;
      const row = yield* storedTicketRowCodec.decode(tickets[0].ticket_json, strict);
      candidateId = `claim:${input.memorySpaceId}:${row.ticket.memoryId}:${hashText(yield* headsCodec.encode(row.ticket.conflictHeadSet))}`;
    }
    const rows = yield* stored(
      "claim-keyed",
      sql<WorkRow>`SELECT o.* FROM memory_outbox o WHERE o.id=${candidateId} AND o.space=${input.memorySpaceId} AND o.kind='claim' AND json_extract(o.frozen_claim_json,'$.attemptId')=${input.attemptId}`,
    );
    return (yield* workRows(rows))[0] ?? null;
  });
  const recoverClaimCandidates = Effect.fn("MemoryStore.recoverClaimCandidates")(function* (
    now: number,
  ) {
    yield* transact(
      Effect.gen(function* () {
        // Each sweep freezes its tail for a cycle, so continuously appended rows
        // cannot postpone revisiting an older frontier or orphan forever.
        const advance = (dimension: string, value: number) =>
          stored(
            "claim-sweep-advance",
            sql`INSERT INTO memory_quota_counters(space,dimension,scope_key,value) VALUES ('_claim_recovery',${dimension},'',${value}) ON CONFLICT(space,dimension,scope_key) DO UPDATE SET value=excluded.value`,
          );
        const sweep = Effect.fnUntraced(function* (
          dimension: string,
          table: "memory_items" | "memory_outbox",
        ) {
          const rows = yield* stored(
            "claim-sweep-cursor",
            sql<{
              dimension: string;
              value: number;
            }>`SELECT dimension,value FROM memory_quota_counters WHERE space='_claim_recovery' AND dimension IN (${dimension},${`${dimension}_upper`}) AND scope_key=''`,
          );
          let after = rows.find((r) => r.dimension === dimension)?.value ?? 0;
          let upper = rows.find((r) => r.dimension === `${dimension}_upper`)?.value ?? 0;
          if (after >= upper) {
            after = 0;
            const tail = yield* stored(
              "claim-sweep-upper",
              sql.unsafe<{ rowid: number }>(
                `SELECT rowid FROM ${table} ORDER BY rowid DESC LIMIT 1`,
              ),
            );
            upper = tail[0]?.rowid ?? 0;
            yield* advance(`${dimension}_upper`, upper);
          }
          return { after, upper };
        });
        const cancel = Effect.fnUntraced(function* (id: string) {
          const tickets = yield* stored(
            "claim-recovery-ticket",
            sql<{
              ticket_json: string;
            }>`SELECT ticket_json FROM memory_outbox WHERE id=${id} AND kind='resolve' AND ticket_json IS NOT NULL`,
          );
          if (tickets[0]) {
            const row = yield* storedTicketRowCodec.decode(tickets[0].ticket_json, strict);
            if (row.submission || (row.approval && row.approval.outcome !== "rejected")) {
              if (!row.reconcileRequired) {
                // Recovery invalidates generation, never the durable result. Do not hydrate bodies.
                yield* stored(
                  "claim-recovery-reconcile",
                  sql`UPDATE memory_outbox SET ticket_json=${yield* storedTicketRowCodec.encode({ ...row, reconcileRequired: true, version: row.version + 1 })},sync_version=sync_version+1 WHERE id=${id} AND sync_version=${row.version}`,
                );
              }
              return;
            }
          }
          yield* clearTerminalSubmission(id);
          yield* stored(
            "claim-cancel",
            sql`UPDATE memory_outbox SET status='cancelled',claimed_by=NULL,claimed_until=NULL,terminal_at=${now},sync_version=sync_version+CASE WHEN kind='claim' THEN 1 ELSE 0 END WHERE id=${id}`,
          );
        });
        const frontier = yield* sweep("frontier", "memory_items");
        const rows = yield* stored(
          "claim-frontiers",
          sql<{
            rowid: number;
            space: string;
            memory_id: string;
            item_json: string;
          }>`SELECT rowid,space,memory_id,item_json FROM memory_items WHERE rowid>${frontier.after} AND rowid<=${frontier.upper} ORDER BY rowid LIMIT ${M.MEMORY_PAGE_MAX_ITEMS}`,
        );
        yield* advance("frontier", rows.at(-1)?.rowid ?? frontier.upper);
        for (const row of rows) {
          const item = yield* projectionCodec.decode(row.item_json, strict);
          const unusable = item.localAvailability.reasons.some((r) =>
            [
              "scanner_pending",
              "secret_detected",
              "missing_parent",
              "dependency_invalidated",
              "forget_pending",
            ].includes(r),
          );
          const eligible =
            item.status === "quarantined" &&
            !unusable &&
            !(yield* readPending(item.memorySpaceId, item.memoryId));
          const work = yield* stored(
            "claim-frontier-work",
            sql<WorkRow>`SELECT * FROM memory_outbox WHERE space=${row.space} AND memory_id=${row.memory_id} AND kind IN ('claim','resolve') AND status NOT IN ('completed','cancelled','failed') ORDER BY id LIMIT ${M.MEMORY_WORK_MAX_PENDING_ITEMS}`,
          );
          for (const candidate of yield* workRows(work)) {
            const heads =
              candidate.metadata.kind === "claim"
                ? candidate.metadata.sortedHeads
                : candidate.metadata.kind === "resolve" && "ticket" in candidate.metadata
                  ? candidate.metadata.ticket.conflictHeadSet
                  : [];
            if (
              !eligible ||
              item.status !== "quarantined" ||
              !sameHeadSet(heads, item.conflict.heads)
            )
              yield* cancel(candidate.id);
            else if (
              candidate.kind === "claim" &&
              candidate.status === "running" &&
              candidate.claimedUntil !== null &&
              candidate.claimedUntil <= now
            ) {
              yield* stored(
                "claim-recovery",
                sql`UPDATE memory_outbox SET status='retry',claimed_by=NULL,claimed_until=NULL WHERE id=${candidate.id}`,
              );
            }
          }
          if (!eligible || item.status !== "quarantined") continue;
          if (
            (yield* stored(
              "claim-recovery-barrier",
              sql`SELECT 1 WHERE ${unresolvedSubmission(row.space, row.memory_id)}`,
            )).length
          )
            continue;
          const headSetDigest = hashText(yield* headsCodec.encode(item.conflict.heads));
          const candidateId = `claim:${row.space}:${row.memory_id}:${headSetDigest}`;
          // An exposure hold can clear without changing heads. Its cancelled
          // attempt stays fenced, but the eligible frontier may start a new one.
          yield* stored(
            "claim-rearm",
            sql`UPDATE memory_outbox SET status='pending',frozen_claim_json=NULL,sync_version=sync_version+1,terminal_at=NULL,next_attempt_at=${now},claimed_by=NULL,claimed_until=NULL WHERE id=${candidateId} AND kind='claim' AND status='cancelled'`,
          );
          yield* enqueueWork({
            id: candidateId,
            space: row.space,
            memoryId: item.memoryId,
            kind: "claim",
            status: "pending",
            metadata: {
              kind: "claim",
              conflictId: item.conflict.conflictId,
              sortedHeads: item.conflict.heads,
              headSetDigest,
            },
            payloadRef: null,
            attempt: 0,
            nextAttemptAt: now,
            claimedBy: null,
            claimedUntil: null,
          });
        }
        const orphan = yield* sweep("orphan", "memory_outbox");
        // Bound inspected history before filtering kinds. Unrelated rows still
        // advance the frozen cursor but never reach the work metadata decoder.
        const work = yield* stored(
          "claim-gone",
          sql<{
            rowid: number;
            id: string | null;
            gone: number;
          }>`WITH page AS MATERIALIZED (
            SELECT rowid FROM memory_outbox WHERE rowid>${orphan.after} AND rowid<=${orphan.upper}
            ORDER BY rowid LIMIT ${M.MEMORY_PAGE_MAX_ITEMS}
          ) SELECT page.rowid,o.id,NOT EXISTS(SELECT 1 FROM memory_items i WHERE i.space=o.space AND i.memory_id=o.memory_id) AS gone
          FROM page LEFT JOIN memory_outbox o ON o.rowid=page.rowid AND o.kind IN ('claim','resolve')
          ORDER BY page.rowid`,
        );
        yield* advance("orphan", work.at(-1)?.rowid ?? orphan.upper);
        for (const row of work)
          if (row.id !== null && row.gone) {
            const candidate = yield* readWork(row.id);
            if (
              candidate &&
              ["claim", "resolve"].includes(candidate.kind) &&
              !["completed", "cancelled", "failed"].includes(candidate.status)
            )
              yield* cancel(row.id);
          }
      }),
    );
  });
  const claimCandidate = Effect.fn("MemoryStore.claimCandidate")(function* (
    id: string,
    epoch: number,
    now: number,
  ) {
    const rows = yield* stored(
      "claim-cas",
      sql`UPDATE memory_outbox SET status='running',claimed_by=${String(epoch)},claimed_until=${now + M.MEMORY_LEASE_MS},attempt=attempt+1 WHERE id=${id} AND attempt<2147483647 AND kind='claim' AND status IN ('pending','retry') AND next_attempt_at<=${now} AND NOT ${unresolvedSubmission(sql.unsafe("memory_outbox.space"), sql.unsafe("memory_outbox.memory_id"))} AND NOT EXISTS (SELECT 1 FROM memory_pending_forget_intents f WHERE f.space=memory_outbox.space AND f.memory_id=memory_outbox.memory_id) RETURNING id`,
    );
    return rows.length === 1;
  });
  const retryClaimCandidate = Effect.fn("MemoryStore.retryClaimCandidate")(function* (
    id: string,
    nextAttemptAt: number,
    _failure: M.MemoryFailureCode,
    leaseExpiresAt?: number,
  ) {
    yield* stored(
      "claim-retry",
      sql`UPDATE memory_outbox SET status='retry',next_attempt_at=${Math.max(nextAttemptAt, leaseExpiresAt ?? 0)},claimed_by=NULL,claimed_until=NULL WHERE id=${id} AND kind='claim'`,
    );
  });
  const completeClaimCandidate = (id: string) => finishWork(id, "completed");
  const persistResolutionTicket = Effect.fn("MemoryStore.persistResolutionTicket")(function* (
    input: M.MemoryResolutionLease,
  ) {
    yield* transact(
      Effect.gen(function* () {
        const ticket = yield* stored("ticket-codec", decodeTicket(input, strict));
        yield* enqueueWork({
          id: `resolve:${ticket.memorySpaceId}:${ticket.attemptId}`,
          space: ticket.memorySpaceId,
          memoryId: ticket.memoryId,
          kind: "resolve",
          status: "pending",
          metadata: { kind: "resolve", ticket },
          payloadRef: null,
          attempt: 0,
          nextAttemptAt: 0,
          claimedBy: null,
          claimedUntil: null,
        });
        const row: TicketRow = {
          ticket,
          version: 0,
          state: "recoverable",
          owner: null,
          coordinatorEpoch: 0,
          ownedUntil: null,
          nextAttemptAt: 0,
          submission: null,
          submissionDigest: null,
          approval: null,
        };
        yield* stored(
          "ticket-initialize",
          sql`UPDATE memory_outbox SET ticket_json=${yield* codec(TicketRowSchema).encode(row)} WHERE id=${`resolve:${ticket.memorySpaceId}:${ticket.attemptId}`} AND ticket_json IS NULL`,
        );
      }),
    );
  });
  const normalizeExpiredReports = Effect.fn("MemoryStore.normalizeExpiredReports")(function* (
    now: number,
    owner?: M.EnvironmentId,
  ) {
    yield* stored(
      "report-exhausted",
      sql`UPDATE memory_report_outbox SET state='failed',failure_code=coalesce(failure_code,'unavailable'),claimed_by=NULL,claimed_until=NULL
      WHERE state!='delivered' AND automatic_attempts=10 AND (state!='failed' OR claimed_by IS NOT NULL OR claimed_until IS NOT NULL) AND (claimed_until IS NULL OR claimed_until<=${now}) AND (${owner ?? null} IS NULL OR resolving_environment_id=${owner ?? null})`,
    );
  });
  const readReportTarget = Effect.fn("MemoryStore.readReportTarget")(function* (reportId: string) {
    const rows = yield* stored(
      "report-target",
      sql<{ space: string; memory_id: string; owner: string }>`
      SELECT space,memory_id,resolving_environment_id AS owner FROM memory_report_outbox WHERE report_id=${reportId}
      UNION SELECT space,memory_id,json_extract(record_json,'$.resolvingEnvironmentId') AS owner FROM memory_import_keys WHERE key_kind='report_delivered' AND key=${reportId}`,
    );
    if (rows.length !== 1) return null;
    const row = rows[0]!;
    return yield* stored(
      "report-target-codec",
      Schema.decodeUnknownEffect(
        Schema.Struct({
          memorySpaceId: M.MemorySpaceId,
          memoryId: M.MemoryId,
          deliveryEnvironmentId: M.EnvironmentId,
        }),
      )(
        { memorySpaceId: row.space, memoryId: row.memory_id, deliveryEnvironmentId: row.owner },
        strict,
      ),
    );
  });
  const nextReportWakeAt = Effect.fn("MemoryStore.nextReportWakeAt")(function* (
    now: number,
    owner: M.EnvironmentId,
  ) {
    const rows = yield* stored(
      "report-wake",
      sql<{
        wake: number | null;
      }>`SELECT min(max(${now},next_attempt_at,coalesce(claimed_until,0))) AS wake FROM memory_report_outbox r
      WHERE resolving_environment_id=${owner} AND state!='delivered' AND report_approved=1 AND report_kind IN ('resolve','revert','conflict_failure') AND ((report_kind='resolve' AND outcome='resolved') OR (report_kind='revert' AND outcome='reverted') OR (report_kind='conflict_failure' AND outcome='failed')) AND (automatic_attempts<10 OR (automatic_attempts=10 AND claimed_until>${now}))
      AND NOT EXISTS(SELECT 1 FROM memory_import_keys g WHERE g.space=r.space AND g.key_kind='report_delivered' AND g.key=r.report_id)`,
    );
    return rows[0]?.wake ?? null;
  });
  const acquireReports: MemoryStore["Service"]["acquireReports"] = Effect.fn(
    "MemoryStore.acquireReports",
  )(function* (input) {
    if (input.until <= input.now) return [];
    return yield* transact(
      Effect.gen(function* () {
        yield* normalizeExpiredReports(input.now, input.owner);
        const rows = yield* stored(
          "report-acquire",
          sql<{
            report_id: string;
          }>`UPDATE memory_report_outbox SET claimed_by=${input.owner},claimed_until=${input.until},automatic_attempts=automatic_attempts+1,attempts_known=1
        WHERE report_id IN (SELECT report_id FROM memory_report_outbox r WHERE resolving_environment_id=${input.owner}
          AND state!='delivered' AND report_approved=1 AND report_kind IN ('resolve','revert','conflict_failure') AND ((report_kind='resolve' AND outcome='resolved') OR (report_kind='revert' AND outcome='reverted') OR (report_kind='conflict_failure' AND outcome='failed')) AND automatic_attempts<10
          AND next_attempt_at<=${input.now} AND (claimed_until IS NULL OR claimed_until<=${input.now})
          AND NOT EXISTS(SELECT 1 FROM memory_import_keys g WHERE g.space=r.space AND g.key_kind='report_delivered' AND g.key=r.report_id)
          ORDER BY next_attempt_at,created_at,report_id LIMIT ${Math.max(0, Math.min(32, Math.floor(input.limit)))}) RETURNING report_id`,
        );
        if (rows.length) yield* markRunnable;
        const claimed = new Set(rows.map((r) => r.report_id));
        // Read only the claimed rows, never materialize the backlog before applying LIMIT.
        return yield* Effect.forEach([...claimed], (reportId) => readReportDelivery(reportId));
      }),
    );
  });
  const readReportDelivery = Effect.fnUntraced(function* (reportId: string) {
    const rows = yield* stored(
      "report-delivery",
      sql<{
        report_id: string;
        operation_id: string;
        outcome: string;
        resolving_environment_id: string;
        resolution_id: string | null;
        state: string;
        failure_code: string | null;
        automatic_attempts: number;
        report_thread_json: string | null;
        delivered_sequence: number | null;
      }>`SELECT report_id,operation_id,outcome,resolving_environment_id,resolution_id,state,failure_code,automatic_attempts,report_thread_json,delivered_sequence FROM memory_report_outbox WHERE report_id=${reportId}`,
    );
    const r = rows[0]!;
    return yield* stored(
      "report-delivery-codec",
      decodeReport(
        {
          reportId: r.report_id,
          operationId: r.operation_id,
          outcome: r.outcome,
          resolvingEnvironmentId: r.resolving_environment_id,
          resolutionId: r.resolution_id,
          state: r.state,
          ...(r.failure_code ? { failureCode: r.failure_code } : {}),
          automaticAttempts: r.automatic_attempts,
          reportThread: r.report_thread_json
            ? yield* threadCodec.decode(r.report_thread_json, strict)
            : null,
          sequence: r.delivered_sequence,
        },
        strict,
      ),
    );
  });
  const acknowledgeClaimedReport: MemoryStore["Service"]["acknowledgeClaimedReport"] = Effect.fn(
    "MemoryStore.acknowledgeClaimedReport",
  )(function* (input) {
    return yield* transact(
      withHubBudget(
        Effect.gen(function* () {
          const d = yield* stored("report-ack-codec", decodeReport(input.delivery, strict));
          if (
            d.state !== "delivered" ||
            !d.reportThread ||
            d.sequence === null ||
            d.reportThread.environmentId !== input.owner
          )
            return false;
          const now = yield* Clock.currentTimeMillis;
          const rows = yield* stored(
            "report-ack-cas",
            sql`SELECT 1 FROM memory_report_outbox WHERE report_id=${d.reportId} AND claimed_by=${input.owner} AND claimed_until=${input.claimUntil} AND claimed_until>${now} AND resolving_environment_id=${input.owner} AND state!='delivered' AND report_approved=1 AND report_kind IN ('resolve','revert','conflict_failure') AND ((report_kind='resolve' AND outcome='resolved') OR (report_kind='revert' AND outcome='reverted') OR (report_kind='conflict_failure' AND outcome='failed'))`,
          );
          if (!rows.length) return false;
          yield* acknowledgeReport(d);
          yield* markRunnable;
          return true;
        }),
      ),
    );
  });
  const deferClaimedReport: MemoryStore["Service"]["deferClaimedReport"] = Effect.fn(
    "MemoryStore.deferClaimedReport",
  )(function* (input) {
    return yield* transact(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const code = yield* stored(
          "report-failure-codec",
          decodeFailureCode(input.failureCode, strict),
        );
        const rows = yield* stored(
          "report-defer-cas",
          sql`UPDATE memory_report_outbox SET state='failed',failure_code=${code},claimed_by=NULL,claimed_until=NULL,next_attempt_at=${Math.max(now + 30_000, Math.min(now + 600_000, input.nextAttemptAt))}
        WHERE report_id=${input.reportId} AND resolving_environment_id=${input.owner} AND claimed_by=${input.owner} AND claimed_until=${input.claimUntil} AND claimed_until>${now} AND state!='delivered'
        AND NOT EXISTS(SELECT 1 FROM memory_import_keys g WHERE g.space=memory_report_outbox.space AND g.key_kind='report_delivered' AND g.key=memory_report_outbox.report_id) RETURNING report_id`,
        );
        if (rows.length) yield* markRunnable;
        return rows.length === 1;
      }),
    );
  });
  const resetReportAttemptsTx: MemoryStore["Service"]["resetReportAttemptsTx"] = Effect.fn(
    "MemoryStore.resetReportAttemptsTx",
  )(function* (input, now) {
    yield* Transaction;
    yield* normalizeExpiredReports(now, input.environmentId);
    let resetCount = 0;
    for (const reportId of input.reportIds) {
      const rows = yield* stored(
        "report-reset",
        sql`UPDATE memory_report_outbox SET automatic_attempts=0 WHERE report_id=${reportId} AND space=${input.memorySpaceId} AND resolving_environment_id=${input.environmentId} AND state='failed' AND automatic_attempts=10 AND claimed_by IS NULL AND claimed_until IS NULL AND report_approved=1 AND report_kind IN ('resolve','revert','conflict_failure') AND ((report_kind='resolve' AND outcome='resolved') OR (report_kind='revert' AND outcome='reverted') OR (report_kind='conflict_failure' AND outcome='failed'))
        AND NOT EXISTS(SELECT 1 FROM memory_import_keys g WHERE g.space=memory_report_outbox.space AND g.key_kind='report_delivered' AND g.key=memory_report_outbox.report_id) RETURNING report_id`,
      );
      resetCount += rows.length;
    }
    if (resetCount) yield* markRunnable;
    return { resetCount, unchangedCount: input.reportIds.length - resetCount };
  });
  const purgeDeliveredReportDetailsTx: MemoryStore["Service"]["purgeDeliveredReportDetailsTx"] =
    Effect.fn("MemoryStore.purgeDeliveredReportDetailsTx")(function* (input) {
      yield* Transaction;
      const rows = yield* stored(
        "report-purge",
        sql.unsafe<{ report_id: string; bytes: number }>(
          `SELECT report_id,${reportMetadataBytes()} AS bytes FROM memory_report_outbox r WHERE ${input.memorySpaceId ? "space=?" : "1=1"} ${input.environmentId ? "AND resolving_environment_id=?" : ""} AND state='delivered' AND delivered_at<=? AND EXISTS(SELECT 1 FROM memory_import_keys g WHERE g.space=r.space AND g.key_kind='report_delivered' AND g.key=r.report_id) ORDER BY delivered_at,report_id LIMIT ?`,
          [
            ...(input.memorySpaceId ? [input.memorySpaceId] : []),
            ...(input.environmentId ? [input.environmentId] : []),
            input.now - M.MEMORY_REPORT_DETAIL_RETENTION_MS,
            Math.max(0, Math.min(256, input.limit)),
          ],
        ),
      );
      for (const r of rows)
        yield* stored(
          "report-purge-delete",
          sql`DELETE FROM memory_report_outbox WHERE report_id=${r.report_id}`,
        );
      return {
        removedRows: rows.length,
        reclaimedLogicalBytes: rows.reduce((n, r) => n + r.bytes, 0),
      };
    });
  const nextReportMaintenanceAt = Effect.fn("MemoryStore.nextReportMaintenanceAt")(function* (
    owner: M.EnvironmentId,
  ) {
    const rows = yield* stored(
      "report-maintenance",
      sql<{
        at: number | null;
      }>`SELECT min(delivered_at)+${M.MEMORY_REPORT_DETAIL_RETENTION_MS} AS at FROM memory_report_outbox r WHERE resolving_environment_id=${owner} AND state='delivered' AND EXISTS(SELECT 1 FROM memory_import_keys g WHERE g.space=r.space AND g.key_kind='report_delivered' AND g.key=r.report_id)`,
    );
    return rows[0]?.at ?? null;
  });
  const pendingReports = Effect.fn("MemoryStore.pendingReports")(function* (limit: number) {
    const rows = yield* stored(
      "reports",
      sql<{
        report_id: string;
        operation_id: string;
        outcome: string;
        resolving_environment_id: string;
        resolution_id: string | null;
        state: string;
        failure_code: string | null;
        report_thread_json: string | null;
        delivered_sequence: number | null;
      }>`SELECT * FROM memory_report_outbox WHERE state IN ('pending','failed') ORDER BY created_at,report_id LIMIT ${Math.min(limit, M.MEMORY_REPORT_MAX_PENDING_ITEMS)}`,
    );
    return yield* stored(
      "report-codec",
      Effect.forEach(rows, (row) =>
        Effect.gen(function* () {
          return yield* decodeReport(
            {
              reportId: row.report_id,
              operationId: row.operation_id,
              outcome: row.outcome,
              resolvingEnvironmentId: row.resolving_environment_id,
              resolutionId: row.resolution_id,
              state: row.state,
              ...(row.failure_code ? { failureCode: row.failure_code } : {}),
              reportThread: row.report_thread_json
                ? yield* threadCodec.decode(row.report_thread_json, strict)
                : null,
              sequence: row.delivered_sequence,
            },
            strict,
          );
        }),
      ),
    );
  });
  const claimReport = Effect.fn("MemoryStore.claimReport")(function* (
    id: string,
    owner: string,
    now: number,
    until: number,
  ) {
    const rows = yield* stored(
      "report-claim",
      sql`UPDATE memory_report_outbox SET claimed_by=${owner},claimed_until=${until} WHERE report_id=${id} AND state='pending' AND (claimed_until IS NULL OR claimed_until<=${now}) RETURNING report_id`,
    );
    return rows.length === 1;
  });
  const acknowledgeReport = Effect.fn("MemoryStore.acknowledgeReport")(function* (
    input: M.MemoryReportDelivery,
  ) {
    return yield* transact(
      Effect.gen(function* () {
        const report = yield* stored("report-codec", decodeReport(input, strict));
        if (report.state !== "delivered" || !report.reportThread || report.sequence === null)
          return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
        const rows = yield* stored(
          "report-ack",
          sql`UPDATE memory_report_outbox SET state='delivered',report_thread_json=${yield* threadCodec.encode(report.reportThread)},delivered_sequence=${report.sequence},delivered_at=${yield* Clock.currentTimeMillis},claimed_by=NULL,claimed_until=NULL WHERE report_id=${report.reportId} AND operation_id=${report.operationId} AND resolving_environment_id=${report.resolvingEnvironmentId} AND outcome=${report.outcome} RETURNING report_id`,
        );
        if (!rows.length) return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
        yield* stored(
          "report-delivery-guard",
          sql`INSERT INTO memory_import_keys(space,key_kind,key,memory_id,record_json)
      SELECT space,'report_delivered',report_id,memory_id,${yield* codec(Schema.Struct({ operationId: M.MemoryOperationId, outcome: Schema.Literals(["resolved", "reverted", "failed"]), resolvingEnvironmentId: M.EnvironmentId })).encode({ operationId: report.operationId, outcome: report.outcome, resolvingEnvironmentId: report.resolvingEnvironmentId })}
      FROM memory_report_outbox WHERE report_id=${report.reportId} ON CONFLICT(space,key_kind,key) DO NOTHING`,
        );
      }),
    );
  });
  const failGenerationAttempt = Effect.fn("MemoryStore.failGenerationAttempt")(function* (input: {
    work: MemoryWork;
    environmentId: M.EnvironmentId;
    failureCode: M.MemoryFailureCode;
    now: number;
    retryAt: number | null;
  }) {
    return yield* transact(
      Effect.gen(function* () {
        const work = input.work;
        const code = yield* stored("failure-code", decodeFailureCode(input.failureCode, strict));
        const environment = yield* stored(
          "failure-environment",
          decodeFailureEnvironment(input.environmentId, strict),
        );
        const current = yield* readWork(work.id);
        if (
          !current ||
          current.status !== "running" ||
          work.status !== "running" ||
          work.claimedBy === null ||
          work.claimedUntil === null ||
          current.claimedBy !== work.claimedBy ||
          current.claimedUntil !== work.claimedUntil ||
          current.attempt !== work.attempt ||
          current.claimedUntil <= input.now
        )
          return false;
        if (
          current.space !== work.space ||
          current.memoryId !== work.memoryId ||
          (yield* workMetadataCodec.encode(current.metadata)) !==
            (yield* workMetadataCodec.encode(work.metadata))
        )
          return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
        const metadata = current.metadata;
        if (
          metadata.kind !== "summary" ||
          !current.memoryId ||
          metadata.sourceThread.environmentId !== environment ||
          !["summary", "consolidate"].includes(current.kind)
        )
          return yield* new MemoryStoreConflict({ code: "unsupported_operation" });
        const reportId = hashText(`${environment}:${work.id}:${work.attempt}:failed`);
        yield* stored(
          "generation-failure-intent",
          sql`INSERT INTO memory_report_outbox
        (report_id,space,memory_id,operation_id,resolution_id,attempt_id,resolving_environment_id,outcome,state,failure_code,created_at,report_kind,report_approved,attempts_known)
        VALUES (${reportId},${current.space},${current.memoryId},${metadata.operationId},NULL,${metadata.operationId},${environment},'failed','pending',${code},${input.now},${current.kind},1,1)
        ON CONFLICT(report_id) DO NOTHING`,
        );
        // Keep the safe failure on its existing work even if report admission refused it.
        yield* stored(
          "generation-failure-code",
          sql`UPDATE memory_outbox SET failure_code=${code} WHERE id=${current.id}`,
        );
        if (input.retryAt !== null) yield* retryWork(current, input.retryAt);
        else yield* finishWork(current.id, "failed");
        return true;
      }),
    );
  });
  const failReport = Effect.fn("MemoryStore.failReport")(function* (
    id: string,
    failure: M.MemoryFailureCode,
  ) {
    yield* stored(
      "report-fail",
      sql`UPDATE memory_report_outbox SET state='failed',failure_code=${failure},claimed_by=NULL,claimed_until=NULL WHERE report_id=${id} AND state!='delivered'`,
    );
  });
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
  const installCheckpointPage: MemoryStore["Service"]["installCheckpointPage"] = Effect.fn(
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
  const completeCheckpoint: MemoryStore["Service"]["completeCheckpoint"] = Effect.fn(
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

  const putLocalIntent = Effect.fn("MemoryStore.putLocalIntent")(function* (
    input: LocalMemoryIntent,
  ) {
    yield* transact(
      Effect.gen(function* () {
        const intent = yield* stored("local-intent-codec", decodeLocalIntent(input, strict));
        const space = `_local:${intent.environmentId}`;
        const old = yield* stored(
          "local-intent",
          sql<{
            metadata_json: string;
          }>`SELECT metadata_json FROM memory_outbox WHERE id=${`local:${intent.environmentId}:${intent.intentId}`}`,
        );
        const json = yield* localMetadataCodec.encode({
          kind: "localIntent",
          intentId: intent.intentId,
          environmentId: intent.environmentId,
          memoryId: intent.memoryId,
          scope: intent.scope,
          provenance: intent.provenance,
          assertionKind: intent.assertionKind,
          createdAtUtc: intent.createdAtUtc,
          mapping: null,
        });
        if (old[0]) {
          if (old[0].metadata_json !== json)
            return yield* new MemoryStoreConflict({ code: "operation_id_reused" });
          return;
        }
        yield* stored(
          "local-intent-payload",
          sql`INSERT INTO memory_payloads (space,payload_ref,memory_id,body_json,dependencies_json) VALUES (${space},${intent.intentId},${intent.memoryId},${yield* payloadCodec.encode(intent.payload)},${yield* headsCodec.encode(intent.payload.derivedFromMemoryRevisions)})`,
        );
        yield* stored(
          "local-intent-outbox",
          sql`INSERT INTO memory_outbox (id,space,memory_id,kind,status,metadata_json,payload_ref,next_attempt_at) VALUES (${`local:${intent.environmentId}:${intent.intentId}`},${space},${intent.memoryId},'admin','pending',${json},${intent.intentId},0)`,
        );
      }),
    );
  });
  const readLocalSummaryPayload = Effect.fn("MemoryStore.readLocalSummaryPayload")(function* (
    environmentId: M.EnvironmentId,
    intentId: string,
  ) {
    const rows = yield* stored(
      "summary-local-payload-read",
      sql<{ body_json: string }>`
      SELECT p.body_json FROM memory_payloads p JOIN memory_outbox o ON o.space=p.space AND o.payload_ref=p.payload_ref
      WHERE o.id=${`local:${environmentId}:${intentId}`} AND o.status!='cancelled'
      AND p.space=${`_local:${environmentId}`} AND p.payload_ref=${intentId}`,
    );
    return rows[0]
      ? yield* stored("summary-local-payload-codec", payloadCodec.decode(rows[0].body_json, strict))
      : undefined;
  });
  const refreshLocalSummaryIntent = Effect.fn("MemoryStore.refreshLocalSummaryIntent")(function* (
    input: LocalMemoryIntent,
  ) {
    yield* transact(
      Effect.gen(function* () {
        const intent = yield* stored("summary-local-codec", decodeLocalIntent(input, strict));
        const source = intent.provenance.sourceThread;
        const watermark = intent.provenance.sourceWatermark;
        if (
          !source ||
          !watermark ||
          source.environmentId !== intent.environmentId ||
          intent.scope.kind !== "thread" ||
          (yield* threadCodec.encode(source)) !== (yield* threadCodec.encode(intent.scope.thread))
        )
          return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
        const id = `local:${intent.environmentId}:${intent.intentId}`;
        const rows = yield* stored(
          "summary-local-read",
          sql<{
            metadata_json: string;
            status: string;
          }>`SELECT metadata_json,status FROM memory_outbox WHERE id=${id}`,
        );
        if (!rows[0]) return yield* putLocalIntent(intent);
        const previous = yield* localMetadataCodec.decode(rows[0].metadata_json, strict);
        if (rows[0].status === "cancelled")
          return yield* new MemoryStoreConflict({ code: "forgotten" });
        if (
          previous.mapping ||
          previous.memoryId !== intent.memoryId ||
          !previous.provenance.sourceThread ||
          (yield* threadCodec.encode(previous.provenance.sourceThread)) !==
            (yield* threadCodec.encode(source))
        )
          return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
        if (
          (previous.provenance.sourceWatermark?.throughSequence ?? 0) >= watermark.throughSequence
        )
          return;
        yield* stored(
          "summary-local-payload",
          sql`UPDATE memory_payloads SET body_json=${yield* payloadCodec.encode(intent.payload)},dependencies_json=${yield* headsCodec.encode(intent.payload.derivedFromMemoryRevisions)} WHERE space=${`_local:${intent.environmentId}`} AND payload_ref=${intent.intentId}`,
        );
        yield* stored(
          "summary-local-metadata",
          sql`UPDATE memory_outbox SET metadata_json=${yield* localMetadataCodec.encode({ kind: "localIntent", intentId: intent.intentId, environmentId: intent.environmentId, memoryId: intent.memoryId, scope: intent.scope, provenance: intent.provenance, assertionKind: intent.assertionKind, createdAtUtc: intent.createdAtUtc, mapping: null })} WHERE id=${id}`,
        );
      }),
    );
  });
  const materializeLocalIntentTx: MemoryStore["Service"]["materializeLocalIntentTx"] = Effect.fn(
    "MemoryStore.materializeLocalIntentTx",
  )(function* (input) {
    yield* Transaction;
    const ready = yield* stored(
      "local-binding-ready",
      sql`SELECT 1 FROM memory_compaction_state WHERE space=${input.memorySpaceId} AND published=1`,
    );
    if (!ready.length) return yield* new MemoryStoreConflict({ code: "bootstrap_required" });
    const id = `local:${input.environmentId}:${input.intentId}`;
    const rows = yield* stored(
      "local-intent",
      sql<{
        metadata_json: string;
        body_json: string;
      }>`SELECT o.metadata_json,p.body_json FROM memory_outbox o JOIN memory_payloads p ON p.space=o.space AND p.payload_ref=o.payload_ref WHERE o.id=${id} AND o.status!='cancelled'`,
    );
    const row = rows[0];
    if (!row) return yield* new MemoryStoreConflict({ code: "not_found" });
    const draft = yield* localMetadataCodec.decode(row.metadata_json, strict);
    if (draft.mapping && draft.mapping.memorySpaceId !== input.memorySpaceId)
      return yield* new MemoryStoreConflict({ code: "space_mismatch" });
    const mapping = draft.mapping ?? {
      memorySpaceId: input.memorySpaceId,
      operationId: input.operationId,
      revisionId: input.revisionId,
    };
    const payload = yield* payloadCodec.decode(row.body_json, strict);
    const operation = yield* stored(
      "materialize-codec",
      decodeOperation(
        {
          protocolVersion: 1,
          kind: "upsert",
          memorySpaceId: mapping.memorySpaceId,
          memoryId: draft.memoryId,
          operationId: mapping.operationId,
          originEnvironmentId: draft.environmentId,
          expectedHeads: [],
          revision: {
            memorySpaceId: mapping.memorySpaceId,
            memoryId: draft.memoryId,
            operationId: mapping.operationId,
            revisionId: mapping.revisionId,
            payloadRef: mapping.revisionId,
            parents: [],
            scope: draft.scope,
            assertionKind: draft.assertionKind,
            provenance: draft.provenance,
            createdAtUtc: draft.createdAtUtc,
          },
          payload,
        },
        strict,
      ),
    );
    yield* stored(
      "materialize-map",
      sql`UPDATE memory_outbox SET metadata_json=${yield* localMetadataCodec.encode({ ...draft, mapping })} WHERE id=${id}`,
    );
    return { operation, operationDigest: hashText(M.encodeMemoryOperation(operation)) };
  });
  const materializeLocalIntent = (input: IntentIdentityInput) =>
    transact(materializeLocalIntentTx(input));
  const completeLocalIntentTx: MemoryStore["Service"]["completeLocalIntentTx"] = Effect.fn(
    "MemoryStore.completeLocalIntentTx",
  )(function* (input) {
    yield* Transaction;
    const { operation: op, operationDigest } = input.materialized;
    const record = yield* receipt(op.memorySpaceId, op.operationId);
    if (
      !record ||
      record.operationDigest !== operationDigest ||
      op.kind !== "upsert" ||
      op.originEnvironmentId !== input.environmentId
    )
      return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
    if (
      record.receipt.outcome !== "rejected" &&
      !("hubSequence" in record.receipt && record.receipt.hubSequence !== null)
    ) {
      const sync = yield* stored(
        "intent-sync",
        sql`SELECT 1 FROM memory_outbox WHERE id=${`sync:${op.memorySpaceId}:${op.operationId}`} AND (operation_digest IS NULL OR operation_digest=${operationDigest})`,
      );
      if (!sync.length) return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
      yield* stored(
        "intent-sync-digest",
        sql`UPDATE memory_outbox SET operation_digest=${operationDigest} WHERE id=${`sync:${op.memorySpaceId}:${op.operationId}`} AND operation_digest IS NULL`,
      );
    }
    const rows = yield* stored(
      "intent-complete",
      sql`UPDATE memory_outbox SET status='completed',terminal_at=coalesce(terminal_at,${input.now}),claimed_by=NULL,claimed_until=NULL
      WHERE id=${`local:${input.environmentId}:${input.intentId}`} AND kind='admin' AND status!='cancelled'
      AND json_extract(metadata_json,'$.mapping.memorySpaceId')=${op.memorySpaceId}
      AND json_extract(metadata_json,'$.mapping.operationId')=${op.operationId}
      AND json_extract(metadata_json,'$.mapping.revisionId')=${op.revision.revisionId} RETURNING id`,
    );
    if (rows.length !== 1) return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
  });

  const prunePayloads = Effect.fn("MemoryStore.prunePayloads")(function* (
    now: number,
    limit: number,
  ) {
    return yield* transact(
      Effect.gen(function* () {
        const rows = yield* stored(
          "payload-retention",
          sql<{
            space: string;
            payload_ref: string;
          }>`SELECT p.space,p.payload_ref FROM memory_payloads p
        WHERE p.purge_eligible_after IS NOT NULL AND p.purge_eligible_after<=${now} AND (p.revert_deadline IS NULL OR p.revert_deadline<=${now})
        AND EXISTS (SELECT 1 FROM memory_compaction_state c WHERE c.space=p.space AND c.published=1)
        AND NOT EXISTS (SELECT 1 FROM memory_items i JOIN json_each(i.heads_json) h JOIN memory_revisions v ON v.space=i.space AND v.revision_id=h.value WHERE i.space=p.space AND v.payload_ref=p.payload_ref)
        AND NOT EXISTS (SELECT 1 FROM memory_conflicts c JOIN json_each(c.heads_json) h JOIN memory_revisions v ON v.space=c.space AND v.revision_id=h.value WHERE c.space=p.space AND c.status!='resolved' AND v.payload_ref=p.payload_ref)
        AND NOT EXISTS (SELECT 1 FROM memory_outbox o WHERE o.space=p.space AND o.payload_ref=p.payload_ref AND o.status IN ('pending','retry','running'))
        AND NOT EXISTS (SELECT 1 FROM memory_revert_intents r WHERE r.space=p.space AND r.payload_ref=p.payload_ref)
        AND NOT EXISTS (SELECT 1 FROM memory_resolutions r JOIN json_each(r.input_payload_refs_json) refs WHERE r.space=p.space AND refs.value=p.payload_ref AND r.revert_deadline>${now})
        AND (EXISTS (SELECT 1 FROM memory_revisions r JOIN memory_events e ON e.memory_space_id=r.space AND e.operation_id=r.operation_id WHERE r.space=p.space AND r.payload_ref=p.payload_ref AND json_extract(e.receipt_json,'$.hubSequence') IS NOT NULL)
        OR EXISTS (SELECT 1 FROM memory_resolutions r
          JOIN memory_compact_receipts k ON k.space=r.space AND json_extract(k.compact_json,'$.operationKind')='resolve'
            AND json_extract(k.compact_json,'$.resolutionId')=r.resolution_id AND json_extract(k.compact_json,'$.revisionId')=r.result_revision_id
            AND json_extract(k.compact_json,'$.receipt.memoryId')=r.memory_id
          JOIN memory_compaction_state c ON c.space=r.space AND c.published=1
          LEFT JOIN memory_revisions v ON v.space=r.space AND v.revision_id=r.result_revision_id
          WHERE r.space=p.space AND r.judgment_payload_ref=p.payload_ref AND r.revert_deadline<=${now}
          AND json_extract(k.receipt_json,'$.outcome')='accepted'
          AND k.hub_sequence<=json_extract(c.boundary_json,'$.checkpointSequence')
          AND NOT EXISTS (SELECT 1 FROM memory_revert_intents ri WHERE ri.space=r.space AND ri.resolution_id=r.resolution_id)
          AND NOT EXISTS (SELECT 1 FROM memory_outbox o WHERE o.space=r.space AND o.status IN ('pending','retry','running') AND (o.payload_ref=v.payload_ref OR instr(o.metadata_json,r.result_revision_id)>0 OR instr(o.metadata_json,r.resolution_id)>0 OR instr(coalesce(o.ticket_json,''),r.result_revision_id)>0 OR instr(coalesce(o.ticket_json,''),r.resolution_id)>0 OR instr(coalesce(o.frozen_claim_json,''),r.result_revision_id)>0 OR instr(coalesce(o.frozen_claim_json,''),r.resolution_id)>0))
          AND NOT EXISTS (SELECT 1 FROM memory_inbox_pending b JOIN memory_hub_retention h ON h.space=b.space WHERE b.space=r.space AND (b.payload_ref=p.payload_ref OR b.reason='hub_snapshot' AND (b.checkpoint_id='hub:'||h.checkpoint_id OR EXISTS(SELECT 1 FROM json_each(h.handles_json) t WHERE 'hub:'||json_extract(t.value,'$.checkpointId')=b.checkpoint_id AND json_extract(t.value,'$.expiresAt')>${now})) AND EXISTS(SELECT 1 FROM json_each(b.metadata_json,'$.resolutions') j WHERE json_extract(j.value,'$.resolution.resolutionId')=r.resolution_id)))))
        ORDER BY p.purge_eligible_after,p.space,p.payload_ref LIMIT ${Math.min(limit, M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS)}`,
        );
        for (const row of rows)
          yield* stored(
            "payload-retention-purge",
            sql`DELETE FROM memory_payloads WHERE space=${row.space} AND payload_ref=${row.payload_ref}`,
          );
        return rows.length;
      }),
    );
  });

  const forgetLocalIntent = Effect.fn("MemoryStore.forgetLocalIntent")(function* (
    environmentId: M.EnvironmentId,
    intentId: string,
  ) {
    yield* transact(
      Effect.gen(function* () {
        const id = `local:${environmentId}:${intentId}`;
        const rows = yield* stored(
          "local-forget",
          sql<{ metadata_json: string }>`SELECT metadata_json FROM memory_outbox WHERE id=${id}`,
        );
        if (!rows[0]) return;
        const draft = yield* localMetadataCodec.decode(rows[0].metadata_json, strict);
        if (draft.mapping) return yield* new MemoryStoreConflict({ code: "space_mismatch" });
        yield* stored(
          "local-forget-purge",
          sql`DELETE FROM memory_payloads WHERE space=${`_local:${environmentId}`} AND payload_ref=${intentId}`,
        );
        yield* stored(
          "local-forget-fence",
          sql`UPDATE memory_outbox SET status='cancelled',payload_ref=NULL WHERE id=${id}`,
        );
      }),
    );
  });
  const stageRevertIntent = Effect.fn("MemoryStore.stageRevertIntent")(function* (input: {
    operation: Extract<M.MemoryOperation, { kind: "revert" }>;
    requestDigest: string;
  }) {
    yield* transact(
      Effect.gen(function* () {
        const op = input.operation;
        const valid = yield* stored("revert-codec", decodeOperation(op, strict));
        if (valid.kind !== "revert")
          return yield* new MemoryStoreConflict({ code: "unsupported_operation" });
        const original = yield* stored(
          "revert-intent",
          sql<{
            request_digest: string;
            operation_id: string;
          }>`SELECT request_digest,operation_id FROM memory_revert_intents WHERE space=${op.memorySpaceId} AND resolution_id=${op.revertsResolutionId}`,
        );
        if (original[0]) {
          if (
            original[0].operation_id !== op.operationId ||
            original[0].request_digest !== input.requestDigest
          )
            return yield* new MemoryStoreConflict({ code: "operation_id_reused" });
          return;
        }
        const current = yield* loadAggregate(
          op.memorySpaceId,
          op.memoryId,
          {},
          {
            resolutionId: op.revertsResolutionId,
          },
        );
        if (current.tombstone || current.pendingForget)
          return yield* new MemoryStoreConflict({ code: "forgotten" });
        const resolution = current.resolutions.find(
          (r) => r.resolutionId === op.revertsResolutionId,
        );
        if (
          !resolution ||
          !resolution.inputRevisionIds.includes(op.restoredRevisionId) ||
          current.heads.length !== 1 ||
          current.heads[0] !== resolution.resultRevisionId ||
          op.expectedHeads[0] !== resolution.resultRevisionId
        )
          return yield* new MemoryStoreConflict({ code: "revision_changed" });
        const now = yield* Clock.currentTimeMillis;

        const body = yield* payloadCodec.encode(op.payload);
        const metadata = yield* metadataCodec.encode(metadataOf(op));
        const usage = yield* storeUsageForRevert(op.memorySpaceId);
        if (
          usage.items >= M.MEMORY_WORK_MAX_PENDING_ITEMS ||
          usage.bytes + new TextEncoder().encode(body + metadata).length >
            M.MEMORY_WORK_MAX_PAYLOAD_BYTES
        )
          return yield* new MemoryCapacityError({
            dimension: "work_bytes",
            limit: M.MEMORY_WORK_MAX_PAYLOAD_BYTES,
          });
        yield* stored(
          "revert-stage-payload",
          sql`INSERT INTO memory_payloads (space,payload_ref,memory_id,body_json,dependencies_json,revert_deadline) VALUES (${op.memorySpaceId},${op.revision.payloadRef},${op.memoryId},${body},${yield* headsCodec.encode(op.payload.derivedFromMemoryRevisions)},${Date.parse(resolution.revertDeadlineUtc)})`,
        );
        yield* stored(
          "revert-stage",
          sql`INSERT INTO memory_revert_intents (space,operation_id,memory_id,resolution_id,restored_revision_id,expected_heads_json,request_digest,submission_metadata_json,payload_ref,created_at) VALUES (${op.memorySpaceId},${op.operationId},${op.memoryId},${op.revertsResolutionId},${op.restoredRevisionId},${yield* headsCodec.encode(op.expectedHeads)},${input.requestDigest},${metadata},${op.revision.payloadRef},${now})`,
        );
        yield* recordRevertResultTx({
          space: op.memorySpaceId,
          memoryId: op.memoryId,
          resolutionId: op.revertsResolutionId,
          operationId: op.operationId,
          slot: { status: "pending" },
        });
        yield* enqueueWork({
          id: `revert:${op.memorySpaceId}:${op.operationId}`,
          space: op.memorySpaceId,
          memoryId: op.memoryId,
          kind: "revert_intent",
          status: "pending",
          metadata: metadataOf(op),
          payloadRef: op.revision.payloadRef,
          attempt: 0,
          nextAttemptAt: 0,
          claimedBy: null,
          claimedUntil: null,
        });
      }),
    );
  });
  const storeUsageForRevert = Effect.fnUntraced(function* (space: M.MemorySpaceId) {
    const rows = yield* stored(
      "revert-work-budget",
      sql<{
        items: number;
        bytes: number;
      }>`SELECT count(*) AS items,coalesce(sum(length(CAST(o.metadata_json AS BLOB))+coalesce(length(CAST(p.body_json AS BLOB)),0)),0) AS bytes FROM memory_outbox o LEFT JOIN memory_payloads p ON p.space=o.space AND p.payload_ref=o.payload_ref WHERE o.space=${space} AND o.status IN ('pending','retry','running')`,
    );
    return rows[0]!;
  });

  const cleanupDerived = Effect.fn("MemoryStore.cleanupDerived")(function* (limit: number) {
    return yield* transact(
      Effect.gen(function* () {
        const rows = yield* stored(
          "cleanup-targets",
          sql<{
            space: string;
            memory_id: string;
            rowid: number;
            generation: number;
            item_json: string;
          }>`SELECT * FROM memory_items WHERE cleanup_pending=1 ORDER BY projection_watermark,memory_id LIMIT ${Math.min(limit, M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS)}`,
        );
        let count = 0;
        for (const row of rows) {
          const success = yield* sql`DELETE FROM memory_items_fts WHERE rowid=${row.rowid}`.pipe(
            Effect.as(true),
            Effect.catch(() => Effect.succeed(false)),
          );
          if (!success) continue;
          const projection = yield* projectionCodec.decode(row.item_json, strict);
          const availability = { ...projection.localAvailability, cleanupPending: false };
          yield* stored(
            "cleanup-settle",
            sql`UPDATE memory_items SET cleanup_pending=0,indexed_bytes=0,indexed_revision=NULL,indexed_generation=NULL,item_json=${yield* projectionCodec.encode({ ...projection, localAvailability: availability })},availability_json=${yield* availabilityCodec.encode(availability)} WHERE space=${row.space} AND memory_id=${row.memory_id} AND generation=${row.generation}`,
          );
          count++;
        }
        return count;
      }),
    );
  });
  const acquireSyncWorkTx: MemoryStore["Service"]["acquireSyncWorkTx"] = Effect.fn(
    "MemoryStore.acquireSyncWorkTx",
  )(function* (input) {
    yield* Transaction;
    if (input.ownedUntil <= input.now) return null;
    const op = yield* readWorkOperation(input.workId);
    if (
      !op ||
      op.operationId !== input.operationId ||
      hashText(M.encodeMemoryOperation(op)) !== input.operationDigest
    )
      return null;
    const rows = yield* stored(
      "sync-acquire",
      sql`
      UPDATE memory_outbox SET status='running', claimed_by=${input.owner}, claimed_until=${input.ownedUntil},
        sync_version=sync_version+1, operation_digest=${input.operationDigest}, attempt=min(attempt+1,2147483647)
      WHERE id=${input.workId} AND kind IN ('sync','revert_intent') AND sync_version=${input.expectedVersion}
        AND (operation_digest IS NULL OR operation_digest=${input.operationDigest}) AND next_attempt_at<=${input.now}
        AND (status IN ('pending','retry') OR (status='running' AND claimed_until<=${input.now})) RETURNING id`,
    );
    return rows.length
      ? {
          workId: input.workId,
          operationId: input.operationId,
          operationDigest: input.operationDigest,
          owner: input.owner,
          version: input.expectedVersion + 1,
          ownedUntil: input.ownedUntil,
        }
      : null;
  });
  const retrySyncWorkTx: MemoryStore["Service"]["retrySyncWorkTx"] = Effect.fn(
    "MemoryStore.retrySyncWorkTx",
  )(function* (input) {
    yield* Transaction;
    const o = input.ownership;
    if ((input.nextAttemptAt === Number.MAX_SAFE_INTEGER) !== (input.holdClass !== undefined))
      return yield* new MemoryStoreConflict({ code: "invalid_output" });
    if (input.nextAttemptAt < input.now) return false;
    const rows = yield* stored(
      "sync-retry",
      sql`
      UPDATE memory_outbox SET status='retry', next_attempt_at=${input.nextAttemptAt}, failure_code=${input.failureCode},hold_class=${input.holdClass ?? null}, claimed_by=NULL, claimed_until=NULL, sync_version=sync_version+1
      WHERE id=${o.workId} AND kind IN ('sync','revert_intent') AND status='running' AND claimed_by=${o.owner}
        AND sync_version=${o.version} AND operation_digest=${o.operationDigest} AND claimed_until=${o.ownedUntil} AND claimed_until>${input.now} RETURNING id`,
    );
    return rows.length === 1;
  });
  const readPullRetry: MemoryStore["Service"]["readPullRetry"] = Effect.fn(
    "MemoryStore.readPullRetry",
  )(function* (input) {
    const rows = yield* stored(
      "pull-retry",
      sql<{
        pull_retry_json: string | null;
      }>`SELECT pull_retry_json FROM memory_sync_cursors WHERE space=${input.memorySpaceId} AND hub_environment_id=${input.hubEnvironmentId}`,
    );
    return rows[0]?.pull_retry_json
      ? yield* pullRetryCodec.decode(rows[0].pull_retry_json, strict)
      : emptyPullRetry;
  });
  // Discovery observes presence, not rearm authority. Outbox work belongs to
  // the space; only pull retry is scoped to the current hub binding.
  const readPersistedHoldClasses: MemoryStore["Service"]["readPersistedHoldClasses"] = Effect.fn(
    "MemoryStore.readPersistedHoldClasses",
  )(function* (input) {
    // Observational probes need no write transaction or checkpoint accounting.
    // Rearm authority and mutations are checked separately inside transact.
    const pull = yield* readPullRetry(input);
    const classes: MemoryHoldClass[] = [];
    for (const holdClass of HoldClass.literals) {
      const held = yield* stored(
        "persisted-hold-discovery",
        sql`SELECT 1 FROM memory_outbox INDEXED BY memory_outbox_held_class
              WHERE space=${input.memorySpaceId} AND hold_class=${holdClass}
                AND hold_class IS NOT NULL AND next_attempt_at=9007199254740991
                AND kind IN ('sync','revert_intent','claim','resolve')
                AND status IN ('pending','retry','running') LIMIT 1`,
      );
      if (
        held.length ||
        (pull.nextAttemptAt === Number.MAX_SAFE_INTEGER && pull.holdClass === holdClass)
      )
        classes.push(holdClass);
    }
    return classes;
  });
  const writePullRetryTx: MemoryStore["Service"]["writePullRetryTx"] = Effect.fn(
    "MemoryStore.writePullRetryTx",
  )(function* (input) {
    yield* Transaction;
    const current = yield* readPullRetry(input);
    if (current.version !== input.expectedVersion) return null;
    if (
      (input.retry.nextAttemptAt === Number.MAX_SAFE_INTEGER) !==
      (input.retry.holdClass !== null)
    )
      return yield* new MemoryStoreConflict({ code: "invalid_output" });
    const next = { ...input.retry, version: current.version + 1 };
    const json = yield* pullRetryCodec.encode(next);
    const rows = yield* stored(
      "pull-retry-write",
      sql`INSERT INTO memory_sync_cursors(space,hub_environment_id,after_sequence,bootstrap_state,pull_retry_json)
      VALUES (${input.memorySpaceId},${input.hubEnvironmentId},0,'unbound',${json})
      ON CONFLICT(space,hub_environment_id) DO UPDATE SET pull_retry_json=excluded.pull_retry_json
      WHERE coalesce(json_extract(memory_sync_cursors.pull_retry_json,'$.version'),0)=${input.expectedVersion} RETURNING space`,
    );
    return rows.length === 1 ? next : null;
  });
  const readWorkHold: MemoryStore["Service"]["readWorkHold"] = Effect.fn(
    "MemoryStore.readWorkHold",
  )(function* (workId) {
    const rows = yield* stored(
      "work-hold",
      sql<{
        hold_class: string | null;
        failure_code: string | null;
      }>`SELECT hold_class,failure_code FROM memory_outbox WHERE id=${workId}`,
    );
    const row = rows[0];
    if (!row) return null;
    return {
      holdClass: row.hold_class
        ? yield* stored("hold-codec", decodeHoldClass(row.hold_class))
        : null,
      failureCode: row.failure_code
        ? yield* stored("failure-codec", decodeFailureCode(row.failure_code))
        : null,
    };
  });
  // Page the existing ID primary key before applying class/space/state filters. Filtering in
  // SQL would make LIMIT bound matches rather than inspected history, and can force a sort.
  const readHoldRearmPage = (afterId: string, limit: number) =>
    stored(
      "hold-rearm-page",
      sql<{
        id: string;
        space: string;
        kind: string;
        status: string;
        next_attempt_at: number;
        hold_class: string | null;
      }>`SELECT id,space,kind,status,next_attempt_at,hold_class
      FROM memory_outbox WHERE id>${afterId} ORDER BY id LIMIT ${Math.max(0, Math.min(limit, M.MEMORY_PAGE_MAX_ITEMS))}`,
    );
  const rearmSyncHoldsTx: MemoryStore["Service"]["rearmSyncHoldsTx"] = Effect.fn(
    "MemoryStore.rearmSyncHoldsTx",
  )(function* (input) {
    yield* Transaction;
    const rows = yield* readHoldRearmPage(input.afterId, input.limit);
    const changed: string[] = [];
    for (const row of rows) {
      if (
        row.space !== input.memorySpaceId ||
        !["sync", "revert_intent"].includes(row.kind) ||
        row.status !== "retry" ||
        row.next_attempt_at !== Number.MAX_SAFE_INTEGER ||
        row.hold_class !== input.holdClass
      )
        continue;
      const updated = yield* stored(
        "sync-hold-rearm",
        sql`UPDATE memory_outbox SET hold_class=NULL,failure_code=NULL,next_attempt_at=${input.now},sync_version=sync_version+1 WHERE id=${row.id} RETURNING id`,
      );
      if (updated.length) changed.push(row.id);
    }
    return holdRearmResult(rows, changed, input.limit);
  });

  const encodeTicketRow = (row: TicketRow) =>
    storedTicketRowCodec.encode({
      ...row,
      submission: row.submission
        ? {
            ...row.submission,
            operation: metadataOf(row.submission.operation),
          }
        : null,
    });
  const submissionMatchesTicket = (
    submission: M.MemoryHubApplyResolutionInput,
    ticket: M.MemoryResolutionLease,
  ) => {
    const op = submission.operation;
    return (
      op.kind === "resolve" &&
      submission.memorySpaceId === ticket.memorySpaceId &&
      submission.attemptId === ticket.attemptId &&
      submission.holderEnvironmentId === ticket.holderEnvironmentId &&
      op.memorySpaceId === ticket.memorySpaceId &&
      op.memoryId === ticket.memoryId &&
      op.originEnvironmentId === ticket.holderEnvironmentId &&
      op.conflictId === ticket.conflictId &&
      op.fencingToken === ticket.fencingToken &&
      op.resolution.fencingToken === ticket.fencingToken &&
      op.resolution.resolvingEnvironmentId === ticket.holderEnvironmentId &&
      sameHeadSet(op.expectedHeads, ticket.conflictHeadSet) &&
      sameHeadSet(op.revision.parents, ticket.conflictHeadSet) &&
      sameHeadSet(op.resolution.inputRevisionIds, ticket.conflictHeadSet) &&
      JSON.stringify(op.resolution.requestedModelSelection) ===
        JSON.stringify(ticket.frozenDefaultModelSelection)
    );
  };
  const decodeTicketRow = Effect.fnUntraced(function* (json: string) {
    const row = yield* stored("ticket-decode", storedTicketRowCodec.decode(json, strict));
    if (!row.submission) return { ...row, submission: null };
    const bodies = yield* stored(
      "ticket-body",
      sql<{
        body_json: string;
      }>`SELECT body_json FROM memory_payloads WHERE space=${row.ticket.memorySpaceId} AND payload_ref=${`submission:${row.ticket.attemptId}`}`,
    );
    if (!bodies[0])
      return yield* new MemoryStorageError({ stage: "ticket-payload", cause: undefined });
    const submission = yield* stored(
      "ticket-submission",
      codec(M.MemoryHubApplyResolutionInput).decode(bodies[0].body_json, strict),
    );
    if (
      !submissionMatchesTicket(submission, row.ticket) ||
      hashText(M.encodeMemoryOperation(submission.operation)) !== row.submissionDigest ||
      (yield* metadataCodec.encode(metadataOf(submission.operation))) !==
        (yield* metadataCodec.encode(row.submission.operation))
    )
      return yield* new MemoryStorageError({ stage: "ticket-payload-identity", cause: undefined });
    return { ...row, submission };
  });
  const prepareClaimAttemptTx: MemoryStore["Service"]["prepareClaimAttemptTx"] = Effect.fn(
    "MemoryStore.prepareClaimAttemptTx",
  )(function* (input) {
    yield* Transaction;
    const now = yield* Clock.currentTimeMillis;
    const rows = yield* stored(
      "claim-prepare",
      sql<WorkRow & { sync_version: number; frozen_claim_json: string | null }>`
      SELECT o.* FROM memory_outbox o JOIN memory_items i ON i.space=o.space AND i.memory_id=o.memory_id
      WHERE o.id=${input.candidateId} AND o.space=${input.memorySpaceId} AND o.kind='claim' AND o.sync_version=${input.expectedGeneration}
      AND o.status IN ('pending','retry','running') AND o.next_attempt_at<=${now} AND i.status='quarantined' AND NOT ${unresolvedSubmission(sql.unsafe("o.space"), sql.unsafe("o.memory_id"))}
      AND NOT EXISTS (SELECT 1 FROM memory_pending_forget_intents f WHERE f.space=i.space AND f.memory_id=i.memory_id)`,
    );
    const row = rows[0];
    if (!row || row.memory_id === null) return null;
    const current = yield* loadAggregate(
      input.memorySpaceId,
      M.MemoryId.make(row.memory_id),
      {},
      {},
    );
    if (
      !sameHeadSet(current.heads, input.conflictHeads) ||
      current.item?.localAvailability.reasons.some((r) =>
        [
          "scanner_pending",
          "secret_detected",
          "missing_parent",
          "dependency_invalidated",
          "forget_pending",
        ].includes(r),
      )
    )
      return null;
    const work = (yield* workRows(rows))[0]!;
    if (work.metadata.kind !== "claim") return null;
    if (row.frozen_claim_json)
      return {
        claim: yield* claimCodec.decode(row.frozen_claim_json, strict),
        generation: row.sync_version,
      };
    if (!input.proposedClaim) return null;
    const claim = yield* stored(
      "claim-input",
      claimCodec.decode(yield* claimCodec.encode(input.proposedClaim), strict),
    );
    if (
      claim.memorySpaceId !== input.memorySpaceId ||
      claim.memoryId !== row.memory_id ||
      claim.conflictId !== work.metadata.conflictId ||
      !sameHeadSet(claim.conflictHeadSet, input.conflictHeads)
    )
      return yield* new MemoryStoreConflict({ code: "conflict_changed" });
    const claimed = yield* stored(
      "claim-persist",
      sql`UPDATE memory_outbox SET frozen_claim_json=${yield* claimCodec.encode(claim)} WHERE id=${input.candidateId} AND sync_version=${input.expectedGeneration} AND frozen_claim_json IS NULL RETURNING id`,
    );
    return claimed.length ? { claim, generation: input.expectedGeneration } : null;
  });
  const readRecoverableResolutionTickets: MemoryStore["Service"]["readRecoverableResolutionTickets"] =
    Effect.fn("MemoryStore.readRecoverableResolutionTickets")(function* (input) {
      const rows = yield* stored(
        "ticket-recovery",
        sql<{
          ticket_json: string;
        }>`SELECT ticket_json FROM memory_outbox WHERE space=${input.memorySpaceId} AND kind='resolve' AND status NOT IN ('cancelled','completed','failed') AND NOT EXISTS (SELECT 1 FROM memory_pending_forget_intents f WHERE f.space=memory_outbox.space AND f.memory_id=memory_outbox.memory_id) AND NOT EXISTS (SELECT 1 FROM memory_tombstones t WHERE t.space=memory_outbox.space AND t.memory_id=memory_outbox.memory_id) AND ticket_json IS NOT NULL AND json_extract(ticket_json,'$.state')!='terminal' AND json_extract(ticket_json,'$.nextAttemptAt')<=${input.now} AND (json_extract(ticket_json,'$.ownedUntil') IS NULL OR json_extract(ticket_json,'$.ownedUntil')<=${input.now}) ORDER BY next_attempt_at,id LIMIT ${Math.max(0, Math.min(input.limit, M.MEMORY_PAGE_MAX_ITEMS))}`,
      );
      return yield* Effect.forEach(rows, (row) => decodeTicketRow(row.ticket_json));
    });
  const ticketId = (key: TicketKey) => `resolve:${key.memorySpaceId}:${key.attemptId}`;
  const readTicket = Effect.fnUntraced(function* (key: TicketKey) {
    const rows = yield* stored(
      "ticket-read",
      sql<{
        ticket_json: string | null;
      }>`SELECT ticket_json FROM memory_outbox WHERE id=${ticketId(key)} AND status NOT IN ('cancelled','completed','failed') AND NOT EXISTS (SELECT 1 FROM memory_pending_forget_intents f WHERE f.space=memory_outbox.space AND f.memory_id=memory_outbox.memory_id) AND NOT EXISTS (SELECT 1 FROM memory_tombstones t WHERE t.space=memory_outbox.space AND t.memory_id=memory_outbox.memory_id)`,
    );
    return rows[0]?.ticket_json ? yield* decodeTicketRow(rows[0].ticket_json) : null;
  });
  const ownedTicket = Effect.fnUntraced(function* (o: TicketOwner, now: number) {
    const row = yield* readTicket(o);
    return row &&
      row.state !== "terminal" &&
      row.version === o.version &&
      row.owner === o.owner &&
      row.coordinatorEpoch === o.coordinatorEpoch &&
      row.ownedUntil !== null &&
      row.ownedUntil > now
      ? row
      : null;
  });
  const writeTicket = Effect.fnUntraced(function* (
    key: TicketKey,
    row: TicketRow,
    expectedVersion: number,
  ) {
    const changed = yield* stored(
      "ticket-write",
      sql`UPDATE memory_outbox SET ticket_json=${yield* encodeTicketRow(row)},sync_version=${row.version},next_attempt_at=${row.nextAttemptAt} WHERE id=${ticketId(key)} AND sync_version=${expectedVersion} RETURNING id`,
    );
    return changed.length ? row : null;
  });
  const acquireResolutionTicketTx: MemoryStore["Service"]["acquireResolutionTicketTx"] = Effect.fn(
    "MemoryStore.acquireResolutionTicketTx",
  )(function* (input) {
    yield* Transaction;
    const row = yield* readTicket(input.key);
    if (
      !row ||
      row.state === "terminal" ||
      row.version !== input.expectedVersion ||
      row.nextAttemptAt > input.now ||
      (row.ownedUntil !== null && row.ownedUntil > input.now) ||
      input.ownedUntil <= input.now
    )
      return null;
    return yield* writeTicket(
      input.key,
      {
        ...row,
        version: row.version + 1,
        owner: input.owner,
        coordinatorEpoch: input.coordinatorEpoch,
        ownedUntil: input.ownedUntil,
      },
      row.version,
    );
  });
  const transitionResolutionTicketTx: MemoryStore["Service"]["transitionResolutionTicketTx"] =
    Effect.fn("MemoryStore.transitionResolutionTicketTx")(function* (input) {
      yield* Transaction;
      const row = yield* ownedTicket(input.ownership, input.now);
      if (!row) return null;
      if (input.retireClaim) {
        const definitiveRejected =
          input.approval?.outcome === "rejected" &&
          row.submission !== null &&
          input.approval.operationId === row.submission.operation.operationId &&
          input.approval.memoryId === row.ticket.memoryId &&
          input.approval.operationDigest === row.submissionDigest &&
          (!row.approval ||
            (row.approval.outcome === "rejected" &&
              row.approval.operationDigest === input.approval.operationDigest &&
              row.approval.operationId === input.approval.operationId));
        if (
          input.nextState !== "terminal" ||
          input.retireClaim.attemptId !== row.ticket.attemptId ||
          ((row.approval || input.approval || row.state === "submitting") && !definitiveRejected)
        )
          return yield* new MemoryStoreConflict({ code: "revision_changed" });
        const retired = yield* stored(
          "claim-retire",
          sql`UPDATE memory_outbox SET frozen_claim_json=NULL,sync_version=sync_version+1,status='retry',claimed_by=NULL,claimed_until=NULL,next_attempt_at=${input.nextAttemptAt}
        WHERE space=${input.ownership.memorySpaceId} AND kind='claim' AND ${input.retireClaim.candidateId === undefined ? sql`1` : sql`id=${input.retireClaim.candidateId}`} AND sync_version=${input.retireClaim.expectedGeneration}
        AND json_extract(frozen_claim_json,'$.attemptId')=${input.retireClaim.attemptId} RETURNING id`,
        );
        if (retired.length !== 1) return null;
      }
      const next: TicketRow = {
        ...row,
        state: input.nextState,
        version: row.version + 1,
        ownedUntil: input.ownedUntil,
        nextAttemptAt: input.nextAttemptAt,
        approval: input.approval ?? row.approval,
        owner: input.ownedUntil === null ? null : row.owner,
      };
      const updated = yield* writeTicket(input.ownership, next, row.version);
      if (updated && input.nextState === "terminal") {
        yield* clearTerminalSubmission(ticketId(input.ownership));
        yield* stored(
          "terminal-resolution-work",
          sql`UPDATE memory_outbox SET status=${updated.approval?.outcome === "rejected" ? "failed" : "completed"},terminal_at=${input.now} WHERE id=${ticketId(input.ownership)}`,
        );
        return {
          ...updated,
          state: "terminal" as const,
          version: updated.version + 1,
          submission: null,
          submissionDigest: null,
          owner: null,
          ownedUntil: null,
        };
      }
      return updated;
    });
  const reconcileResolutionSubmissionTx: MemoryStore["Service"]["reconcileResolutionSubmissionTx"] =
    Effect.fn("MemoryStore.reconcileResolutionSubmissionTx")(function* (input) {
      yield* Transaction;
      const row = yield* ownedTicket(input.ownership, input.now);
      if (!row?.submission || !row.submissionDigest) return null;
      const op = row.submission.operation;
      // All receipt sources are uniquely keyed by (space, operationId). Absence is uncertainty,
      // including compacted/offline logs; a changed frontier alone is never negative proof.
      const receipts = yield* stored(
        "resolution-admission-keyed",
        sql<{ operation_digest: string; receipt_json: string }>`
        SELECT operation_digest,receipt_json FROM memory_events WHERE memory_space_id=${input.ownership.memorySpaceId} AND operation_id=${op.operationId}
        UNION ALL SELECT operation_digest,receipt_json FROM memory_compact_receipts WHERE space=${input.ownership.memorySpaceId} AND operation_id=${op.operationId}
        UNION ALL SELECT json_extract(record_json,'$.receipt.operationDigest'),json_extract(record_json,'$.receipt') FROM memory_import_keys WHERE space=${input.ownership.memorySpaceId} AND key_kind='hubReceipt' AND key=${op.operationId} LIMIT 3`,
      );
      let admitted: M.MemoryHubReceipt | undefined;
      for (const canonical of receipts) {
        if (canonical.operation_digest !== row.submissionDigest)
          return yield* new MemoryStoreConflict({ code: "operation_id_reused" });
        const value = yield* receiptCodec.decode(canonical.receipt_json, strict);
        if ("hubSequence" in value) {
          if (
            admitted &&
            (yield* hubReceiptCodec.encode(admitted)) !== (yield* hubReceiptCodec.encode(value))
          )
            return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
          admitted = value;
        }
      }
      const evidence = admitted ?? row.approval ?? input.rejection;
      const result = evidence
        ? yield* hubReceiptCodec.decode(yield* hubReceiptCodec.encode(evidence), strict)
        : undefined;
      if (!result) return { outcome: "uncertain" as const, row };
      if (
        result.operationId !== op.operationId ||
        result.memoryId !== row.ticket.memoryId ||
        result.operationDigest !== row.submissionDigest ||
        !M.validateMemoryResolutionApproval(
          op.kind,
          op.kind === "resolve" ? op.resolution.resolutionId : null,
          result,
        )
      )
        return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
      if (
        input.rejection &&
        (input.rejection.outcome !== "rejected" ||
          input.rejection.operationId !== op.operationId ||
          input.rejection.operationDigest !== row.submissionDigest ||
          input.rejection.memoryId !== row.ticket.memoryId)
      )
        return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
      if (result.outcome !== "rejected") {
        if (result.hubSequence === null)
          return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
        const updated = yield* writeTicket(
          input.ownership,
          { ...row, state: "approved", approval: result, version: row.version + 1 },
          row.version,
        );
        return updated ? { outcome: "admitted" as const, row: updated, receipt: result } : null;
      }
      if (row.approval && row.approval.outcome !== "rejected")
        return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
      const candidateId = `claim:${row.ticket.memorySpaceId}:${row.ticket.memoryId}:${hashText(yield* headsCodec.encode(row.ticket.conflictHeadSet))}`;
      yield* stored(
        "reconcile-rejected-claim",
        sql`UPDATE memory_outbox SET frozen_claim_json=NULL,sync_version=sync_version+1,status='retry',terminal_at=NULL,claimed_by=NULL,claimed_until=NULL,next_attempt_at=${input.now} WHERE id=${candidateId} AND kind='claim' AND json_extract(frozen_claim_json,'$.attemptId')=${row.ticket.attemptId}`,
      );
      const updated = yield* transitionResolutionTicketTx({
        ownership: input.ownership,
        now: input.now,
        nextState: "terminal",
        ownedUntil: null,
        nextAttemptAt: input.now,
        approval: result,
      });
      if (!updated) return yield* new MemoryStoreConflict({ code: "fenced" });
      return { outcome: "retired" as const, row: updated };
    });
  const retireRejectedSubmissionTx: MemoryStore["Service"]["retireRejectedSubmissionTx"] =
    Effect.fn("MemoryStore.retireRejectedSubmissionTx")(function* (input) {
      yield* Transaction;
      const row = yield* ownedTicket(input.ownership, input.now);
      if (!row) return null;
      const rejection = yield* hubReceiptCodec.decode(
        yield* hubReceiptCodec.encode(input.rejection),
        strict,
      );
      if (
        rejection.outcome !== "rejected" ||
        !row.submission ||
        rejection.operationId !== row.submission.operation.operationId ||
        rejection.memoryId !== row.ticket.memoryId ||
        rejection.operationDigest !== row.submissionDigest ||
        (row.approval && row.approval.outcome !== "rejected") ||
        input.nextAttemptAt < input.now
      )
        return yield* new MemoryStoreConflict({ code: "revision_changed" });
      return yield* transitionResolutionTicketTx({
        ownership: input.ownership,
        nextState: "terminal",
        now: input.now,
        ownedUntil: null,
        nextAttemptAt: input.nextAttemptAt,
        approval: rejection,
        retireClaim: {
          candidateId: input.candidateId,
          expectedGeneration: input.expectedGeneration,
          attemptId: row.ticket.attemptId,
        },
      });
    });
  const renewResolutionTicketTx: MemoryStore["Service"]["renewResolutionTicketTx"] = Effect.fn(
    "MemoryStore.renewResolutionTicketTx",
  )(function* (input) {
    yield* Transaction;
    const row = yield* ownedTicket(input.ownership, input.now);
    if (
      !row ||
      row.state === "terminal" ||
      row.ticket.expiresAtHubTime !== input.expectedExpiresAtHubTime
    )
      return null;
    const renewed = yield* stored("renewed-ticket-codec", decodeTicket(input.renewedLease, strict));
    const old = row.ticket;
    if (
      renewed.memorySpaceId !== old.memorySpaceId ||
      renewed.memoryId !== old.memoryId ||
      renewed.conflictId !== old.conflictId ||
      renewed.attemptId !== old.attemptId ||
      renewed.holderEnvironmentId !== old.holderEnvironmentId ||
      renewed.fencingToken !== old.fencingToken ||
      renewed.claimedAtHubTime !== old.claimedAtHubTime ||
      renewed.attemptDeadlineHubTime !== old.attemptDeadlineHubTime ||
      !sameHeadSet(renewed.conflictHeadSet, old.conflictHeadSet) ||
      (yield* selectionCodec.encode(renewed.frozenDefaultModelSelection)) !==
        (yield* selectionCodec.encode(old.frozenDefaultModelSelection)) ||
      Date.parse(renewed.expiresAtHubTime) < Date.parse(old.expiresAtHubTime)
    )
      return yield* new MemoryStoreConflict({ code: "fenced" });
    return yield* writeTicket(
      input.ownership,
      { ...row, ticket: renewed, version: row.version + 1 },
      row.version,
    );
  });
  const failResolutionTicketTx: MemoryStore["Service"]["failResolutionTicketTx"] = Effect.fn(
    "MemoryStore.failResolutionTicketTx",
  )(function* (input) {
    yield* Transaction;
    const row = yield* ownedTicket(input.ownership, input.now);
    if (!row || row.state === "terminal" || row.approval) return null;
    if (
      input.nextAttemptAt < input.now ||
      (input.nextAttemptAt === Number.MAX_SAFE_INTEGER) !== (input.holdClass !== undefined)
    )
      return yield* new MemoryStoreConflict({ code: "invalid_output" });
    // An uncertain submission is preserved and is never announced as a failed conflict.
    if (input.reportConflictFailure && row.submission)
      return yield* new MemoryStoreConflict({ code: "revision_changed" });
    const next = yield* writeTicket(
      input.ownership,
      {
        ...row,
        version: row.version + 1,
        state: row.submission ? "submitting" : "recoverable",
        owner: null,
        ownedUntil: null,
        nextAttemptAt: input.nextAttemptAt,
      },
      row.version,
    );
    if (!next) return null;
    yield* stored(
      "ticket-failure",
      sql`UPDATE memory_outbox SET hold_class=${input.holdClass ?? null},failure_code=${input.failureCode} WHERE id=${ticketId(input.ownership)} AND sync_version=${next.version}`,
    );
    if (input.reportConflictFailure) {
      const reportId = hashText(
        `${row.ticket.memorySpaceId}:${row.ticket.attemptId}:conflict-failed`,
      );
      yield* stored(
        "conflict-failure-report",
        sql`INSERT INTO memory_report_outbox(report_id,space,memory_id,operation_id,resolution_id,attempt_id,resolving_environment_id,outcome,state,failure_code,created_at,report_kind,report_approved,attempts_known)
        SELECT ${reportId},${row.ticket.memorySpaceId},${row.ticket.memoryId},${row.ticket.attemptId},NULL,${row.ticket.attemptId},${row.ticket.holderEnvironmentId},'failed','pending',${input.failureCode},${input.now},'conflict_failure',1,1
        WHERE NOT EXISTS (SELECT 1 FROM memory_import_keys WHERE space=${row.ticket.memorySpaceId} AND key_kind='report_delivered' AND key=${reportId}) ON CONFLICT(report_id) DO NOTHING`,
      );
      yield* markRunnable;
    }
    return next;
  });
  const holdClaimCandidateTx: MemoryStore["Service"]["holdClaimCandidateTx"] = Effect.fn(
    "MemoryStore.holdClaimCandidateTx",
  )(function* (input) {
    yield* Transaction;
    const rows = yield* stored(
      "claim-hold",
      sql`UPDATE memory_outbox SET status='retry',hold_class=${input.holdClass},failure_code=${input.failureCode},next_attempt_at=${Number.MAX_SAFE_INTEGER},claimed_by=NULL,claimed_until=NULL
      WHERE id=${input.candidateId} AND space=${input.memorySpaceId} AND kind='claim' AND status='running' AND sync_version=${input.expectedGeneration}
      AND attempt=${input.expectedAttempt} AND json_extract(frozen_claim_json,'$.attemptId')=${input.attemptId} AND claimed_by=${String(input.coordinatorEpoch)} AND claimed_until>${input.now} RETURNING id`,
    );
    return rows.length === 1;
  });
  const holdResolutionAttemptTx: MemoryStore["Service"]["holdResolutionAttemptTx"] = Effect.fn(
    "MemoryStore.holdResolutionAttemptTx",
  )(function* (input) {
    yield* Transaction;
    const row = yield* ownedTicket(input.ownership, input.now);
    // Submitted work needs reconciliation. A permanent refusal must never retire its
    // frozen attempt or manufacture a failure report, including approval-only rows.
    if (!row || row.submission || row.submissionDigest || row.approval) return null;
    const candidateId = `claim:${row.ticket.memorySpaceId}:${row.ticket.memoryId}:${hashText(yield* headsCodec.encode(row.ticket.conflictHeadSet))}`;
    if (input.candidateId !== candidateId) return null;
    const changed = yield* stored(
      "resolution-attempt-hold",
      sql`UPDATE memory_outbox SET status='retry',hold_class=${input.holdClass},failure_code=${input.failureCode},next_attempt_at=${Number.MAX_SAFE_INTEGER},claimed_by=NULL,claimed_until=NULL
      WHERE id=${input.candidateId} AND space=${row.ticket.memorySpaceId} AND memory_id=${row.ticket.memoryId} AND kind='claim'
      AND sync_version=${input.expectedGeneration} AND attempt=${input.expectedAttempt}
      AND json_extract(frozen_claim_json,'$.attemptId')=${row.ticket.attemptId}
      AND ((status='running' AND claimed_by=${String(input.ownership.coordinatorEpoch)} AND claimed_until>${input.now})
        OR (status='retry' AND claimed_by IS NULL AND claimed_until IS NULL)) RETURNING id`,
    );
    if (changed.length !== 1) return null;
    const held = yield* failResolutionTicketTx({
      ownership: input.ownership,
      now: input.now,
      failureCode: input.failureCode,
      nextAttemptAt: Number.MAX_SAFE_INTEGER,
      holdClass: input.holdClass,
      reportConflictFailure: false,
    });
    // Fail, rather than return null, after the first write so the enclosing Tx rolls
    // both rows back if the ticket CAS unexpectedly loses its fence.
    if (!held) return yield* new MemoryStoreConflict({ code: "fenced" });
    return held;
  });
  const rearmResolutionHoldsTx: MemoryStore["Service"]["rearmResolutionHoldsTx"] = Effect.fn(
    "MemoryStore.rearmResolutionHoldsTx",
  )(function* (input) {
    yield* Transaction;
    const rows = yield* readHoldRearmPage(input.afterId, input.limit);
    const changed: string[] = [];
    for (const row of rows) {
      if (
        row.space !== input.memorySpaceId ||
        !["claim", "resolve"].includes(row.kind) ||
        ["cancelled", "completed", "failed"].includes(row.status) ||
        row.next_attempt_at !== Number.MAX_SAFE_INTEGER ||
        row.hold_class !== input.holdClass
      )
        continue;
      if (row.kind === "resolve") {
        const tickets = yield* stored(
          "held-ticket",
          sql<{
            ticket_json: string | null;
          }>`SELECT ticket_json FROM memory_outbox WHERE id=${row.id}`,
        );
        if (!tickets[0]?.ticket_json) continue;
        // Rearm is scheduling-only. Decode persisted metadata without reading uncertain
        // submission bodies; retain that metadata and digest byte-for-byte in the next row.
        const ticket = yield* stored(
          "held-ticket-metadata",
          storedTicketRowCodec.decode(tickets[0].ticket_json, strict),
        );
        if (
          ticket.state === "terminal" ||
          ticket.approval ||
          (ticket.ownedUntil !== null && ticket.ownedUntil > input.now)
        )
          continue;
        const next = {
          ...ticket,
          version: ticket.version + 1,
          owner: null,
          ownedUntil: null,
          nextAttemptAt: input.now,
        };
        const advanced = yield* stored(
          "held-ticket-rearm",
          sql`UPDATE memory_outbox SET ticket_json=${yield* storedTicketRowCodec.encode(next)},sync_version=${next.version},next_attempt_at=${input.now}
          WHERE id=${row.id} AND sync_version=${ticket.version} RETURNING id`,
        );
        if (!advanced.length) continue;
      }
      const updated = yield* stored(
        "resolution-hold-rearm",
        sql`UPDATE memory_outbox SET hold_class=NULL,failure_code=NULL,next_attempt_at=${input.now},claimed_by=NULL,claimed_until=NULL WHERE id=${row.id} AND hold_class=${input.holdClass} RETURNING id`,
      );
      if (updated.length) changed.push(row.id);
    }
    return holdRearmResult(rows, changed, input.limit);
  });
  const persistResolutionSubmissionTx: MemoryStore["Service"]["persistResolutionSubmissionTx"] =
    Effect.fn("MemoryStore.persistResolutionSubmissionTx")(function* (input) {
      yield* Transaction;
      const row = yield* ownedTicket(input.ownership, yield* Clock.currentTimeMillis);
      if (!row) return yield* new MemoryStoreConflict({ code: "fenced" });
      const submission = yield* stored(
        "submission-codec",
        submissionDecode(input.submission, strict),
      );
      if (
        !submissionMatchesTicket(submission, row.ticket) ||
        hashText(M.encodeMemoryOperation(submission.operation)) !== input.digest
      )
        return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
      if (
        row.submission &&
        (row.submissionDigest !== input.digest ||
          (yield* codec(M.MemoryHubApplyResolutionInput).encode(row.submission)) !==
            (yield* codec(M.MemoryHubApplyResolutionInput).encode(submission)))
      )
        return yield* new MemoryStoreConflict({ code: "operation_id_reused" });
      if (row.submission) return row;
      const op = submission.operation;
      if (op.kind !== "resolve")
        return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
      const payloadRef = `submission:${row.ticket.attemptId}`;
      const body = yield* codec(M.MemoryHubApplyResolutionInput).encode(submission);
      const usage = yield* storeUsageForRevert(op.memorySpaceId);
      if (usage.bytes + new TextEncoder().encode(body).length > M.MEMORY_WORK_MAX_PAYLOAD_BYTES)
        return yield* new MemoryStoreConflict({ code: "capacity_exceeded" });
      yield* stored(
        "submission-body",
        sql`INSERT INTO memory_payloads(space,payload_ref,memory_id,body_json,dependencies_json,purge_eligible_after) VALUES (${op.memorySpaceId},${payloadRef},${op.memoryId},${body},${yield* headsCodec.encode(op.payload.derivedFromMemoryRevisions)},${Date.parse(row.ticket.attemptDeadlineHubTime) + M.MEMORY_REPLACED_PAYLOAD_RETENTION_MS})`,
      );
      yield* stored(
        "submission-ref",
        sql`UPDATE memory_outbox SET payload_ref=${payloadRef} WHERE id=${ticketId(input.ownership)} AND sync_version=${row.version}`,
      );
      const updated = yield* writeTicket(
        input.ownership,
        {
          ...row,
          state: "submitting",
          version: row.version + 1,
          submission,
          submissionDigest: input.digest,
        },
        row.version,
      );
      if (!updated) return yield* new MemoryStoreConflict({ code: "fenced" });
      return updated;
    });
  const listMaterializableIntents: MemoryStore["Service"]["listMaterializableIntents"] = Effect.fn(
    "MemoryStore.listMaterializableIntents",
  )(function* (environment, limit) {
    const rows = yield* stored(
      "intent-list",
      sql<{
        metadata_json: string;
        body_json: string;
      }>`SELECT o.metadata_json,p.body_json FROM memory_outbox o JOIN memory_payloads p ON p.space=o.space AND p.payload_ref=o.payload_ref WHERE o.space=${`_local:${environment}`} AND o.kind='admin' AND o.status IN ('pending','retry') AND json_extract(o.metadata_json,'$.kind')='localIntent' ORDER BY o.id LIMIT ${Math.max(0, Math.min(limit, M.MEMORY_PAGE_MAX_ITEMS))}`,
    );
    return yield* Effect.forEach(rows, (row) =>
      Effect.gen(function* () {
        const {
          kind: _kind,
          mapping: _mapping,
          ...intent
        } = yield* localMetadataCodec.decode(row.metadata_json, strict);
        return { ...intent, payload: yield* payloadCodec.decode(row.body_json, strict) };
      }),
    );
  });
  const assignIntentIdentityTx: MemoryStore["Service"]["assignIntentIdentityTx"] = Effect.fn(
    "MemoryStore.assignIntentIdentityTx",
  )(function* (input) {
    yield* Transaction;
    const id = `local:${input.environmentId}:${input.intentId}`;
    const rows = yield* stored(
      "intent-assign",
      sql<{
        metadata_json: string;
        body_json: string;
      }>`SELECT o.metadata_json,p.body_json FROM memory_outbox o JOIN memory_payloads p ON p.space=o.space AND p.payload_ref=o.payload_ref WHERE o.id=${id} AND o.status!='cancelled'`,
    );
    if (!rows[0]) return yield* new MemoryStoreConflict({ code: "not_found" });
    const metadata = yield* localMetadataCodec.decode(rows[0].metadata_json, strict);
    if (metadata.environmentId !== input.environmentId)
      return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
    const mapping = metadata.mapping ?? {
      memorySpaceId: input.memorySpaceId,
      operationId: input.operationId,
      revisionId: input.revisionId,
    };
    if (mapping.memorySpaceId !== input.memorySpaceId)
      return yield* new MemoryStoreConflict({ code: "space_mismatch" });
    if (!metadata.mapping)
      yield* stored(
        "intent-assigned",
        sql`UPDATE memory_outbox SET metadata_json=${yield* localMetadataCodec.encode({ ...metadata, mapping })} WHERE id=${id}`,
      );
    const { kind: _kind, mapping: _mapping, ...intent } = metadata;
    return {
      ...mapping,
      intent: { ...intent, payload: yield* payloadCodec.decode(rows[0].body_json, strict) },
    };
  });
  type MemberRow = {
    space: string;
    environment: string;
    credential_digest: string;
    credential_version: number;
    status: "active" | "revoked";
    joined_at: number | null;
  };
  const memberFrom = (row: MemberRow): HubMember => ({
    memorySpaceId: M.MemorySpaceId.make(row.space),
    environmentId: M.EnvironmentId.make(row.environment),
    credentialDigest: row.credential_digest,
    credentialVersion: row.credential_version,
    status: row.status,
    joinedAt: row.joined_at,
  });
  // One space-indexed roster query. The bounded pending admin partition supplies
  // confirmation state; the authority table remains active/revoked throughout install.
  const readHubMembers: MemoryStore["Service"]["readHubMembers"] = Effect.fn(
    "MemoryStore.readHubMembers",
  )(function* (space) {
    const rows = yield* stored(
      "hub-members",
      sql<{
        environment: string;
        credential_version: number;
        status: M.MemoryHubMemberView["status"];
        joined_at: number | null;
      }>`WITH pending AS MATERIALIZED (
        SELECT json_extract(admin_json,'$.action.environmentId') AS environment,
          json_extract(admin_json,'$.memberVersion') AS version,
          json_extract(admin_json,'$.result.view.settings.memorySpaceId') AS space
        FROM memory_outbox WHERE space='_admin' AND kind='admin' AND status='pending'
          AND json_extract(admin_json,'$.stage') IN ('activated','ready')
          AND json_extract(admin_json,'$.action.action') IN ('provisionMember','rotateMemberCredential')
      ) SELECT m.environment,m.credential_version,m.joined_at,
      CASE WHEN EXISTS (
        SELECT 1 FROM pending AS p WHERE p.environment=m.environment
          AND p.version=m.credential_version AND (p.space IS NULL OR p.space=m.space)
      ) THEN 'pending_ack' ELSE 'active' END AS status
      FROM memory_hub_members AS m WHERE m.space=${space} AND m.status='active'
      ORDER BY m.environment LIMIT ${M.MEMORY_HUB_MAX_MEMBERS}`,
    );
    return rows.map((row) => ({
      environmentId: M.EnvironmentId.make(row.environment),
      credentialVersion: row.credential_version,
      status: row.status,
      joinedAt: row.joined_at,
    }));
  });
  const readHubMember: MemoryStore["Service"]["readHubMember"] = Effect.fn(
    "MemoryStore.readHubMember",
  )(function* (space, environment) {
    const rows = yield* stored(
      "hub-member",
      sql<MemberRow>`SELECT * FROM memory_hub_members WHERE space=${space} AND environment=${environment}`,
    );
    return rows[0] ? memberFrom(rows[0]) : undefined;
  });
  const findHubMemberByCredential: MemoryStore["Service"]["findHubMemberByCredential"] = Effect.fn(
    "MemoryStore.findHubMemberByCredential",
  )(function* (credentialDigest) {
    const rows = yield* stored(
      "hub-credential",
      sql<MemberRow>`SELECT * FROM memory_hub_members WHERE credential_digest=${credentialDigest}`,
    );
    return rows[0] ? memberFrom(rows[0]) : undefined;
  });
  const requireHubMemberTx: MemoryStore["Service"]["requireHubMemberTx"] = Effect.fn(
    "MemoryStore.requireHubMemberTx",
  )(function* (principal) {
    yield* Transaction;
    const member = yield* readHubMember(principal.memorySpaceId, principal.environmentId);
    if (
      !member ||
      member.status !== "active" ||
      member.credentialVersion !== principal.credentialVersion
    )
      return yield* new M.MemoryHubUnauthorizedError({});
    if (!principal.scopes.includes("memory:sync")) return yield* new M.MemoryHubForbiddenError({});
    return member;
  });
  const adminDecode = Schema.decodeUnknownEffect(AdminRecordSchema);
  const readHubAdminTx: MemoryStore["Service"]["readHubAdminTx"] = Effect.fn(
    "MemoryStore.readHubAdminTx",
  )(function* (requestId) {
    yield* Transaction;
    const rows = yield* stored(
      "hub-admin-read",
      sql<{
        admin_json: string;
      }>`SELECT admin_json FROM memory_outbox WHERE id=${`admin:${requestId}`} AND kind='admin'`,
    );
    if (rows[0])
      return yield* stored("hub-admin-codec", adminCodec.decode(rows[0].admin_json, strict));
    const guards = yield* stored(
      "hub-admin-replay",
      sql<{
        record_json: string;
      }>`SELECT record_json FROM memory_import_keys WHERE space='_admin' AND key_kind='hub_admin' AND key=${requestId}`,
    );
    return guards[0] ? yield* adminReplayCodec.decode(guards[0].record_json, strict) : undefined;
  });
  const writeHubAdminTx: MemoryStore["Service"]["writeHubAdminTx"] = Effect.fn(
    "MemoryStore.writeHubAdminTx",
  )(function* (input) {
    yield* Transaction;
    const record = yield* stored("hub-admin-codec", adminDecode(input.record, strict));
    yield* stored(
      "hub-admin-provenance",
      sql`INSERT INTO memory_hub_administration_state(singleton,administered) VALUES(1,1) ON CONFLICT(singleton) DO UPDATE SET administered=1`,
    );
    const json = yield* stored("hub-admin-codec", adminCodec.encode(record));
    if (new TextEncoder().encode(json).length > M.MEMORY_PAGE_MAX_UTF8_BYTES)
      return yield* new MemoryStoreConflict({ code: "payload_too_large" });
    const old = yield* readHubAdminTx(record.requestId);
    if (old && !("action" in old)) {
      if (
        old.requestDigest !== record.requestDigest ||
        old.expectedVersion !== record.expectedVersion ||
        old.initialization !== record.initialization ||
        old.actionDigest !== hashText(yield* adminActionCodec.encode(record.action)) ||
        old.secretName !== record.secretName
      )
        return yield* new MemoryStoreConflict({ code: "operation_id_reused" });
      // Replay returns the original terminal result, never recreates work or a credential.
      return { ...record, stage: old.stage, result: old.result, memberVersion: old.memberVersion };
    }
    if (old) {
      if (
        old.requestDigest !== record.requestDigest ||
        old.expectedVersion !== record.expectedVersion ||
        old.initialization !== record.initialization ||
        (yield* adminActionCodec.encode(old.action)) !==
          (yield* adminActionCodec.encode(record.action)) ||
        old.secretName !== record.secretName
      )
        return yield* new MemoryStoreConflict({ code: "operation_id_reused" });
      if ((yield* adminCodec.encode(old)) === json) return old;
      const stages = ["prepared", "activated", "ready", "acknowledged"];
      if (
        old.stage !== input.expectedStage ||
        stages.indexOf(record.stage) !== stages.indexOf(old.stage) + 1 ||
        (old.memberVersion !== null && old.memberVersion !== record.memberVersion)
      )
        return yield* new MemoryStoreConflict({ code: "revision_changed" });
    } else if (
      input.expectedStage !== null ||
      record.stage !== "prepared" ||
      record.memberVersion !== null ||
      record.result !== null
    )
      return yield* new MemoryStoreConflict({ code: "revision_changed" });
    const counts = yield* stored(
      "hub-admin-budget",
      sql<{
        rows: number;
        bytes: number;
      }>`SELECT count(*) AS rows,coalesce(sum(length(CAST(admin_json AS BLOB))),0) AS bytes FROM memory_outbox WHERE kind='admin'`,
    );
    const previousBytes = old ? new TextEncoder().encode(yield* adminCodec.encode(old)).length : 0;
    if (
      counts[0]!.rows + Number(!old) > M.MEMORY_WORK_MAX_PENDING_ITEMS ||
      counts[0]!.bytes + new TextEncoder().encode(json).length - previousBytes >
        M.MEMORY_WORK_MAX_PAYLOAD_BYTES
    )
      return yield* new MemoryCapacityError({
        dimension: "work_bytes",
        limit: M.MEMORY_WORK_MAX_PAYLOAD_BYTES,
      });
    const terminalAt = record.stage === "acknowledged" ? yield* Clock.currentTimeMillis : null;
    yield* stored(
      "hub-admin-write",
      sql`INSERT INTO memory_outbox(id,space,kind,status,metadata_json,admin_json,next_attempt_at,terminal_at) VALUES (${`admin:${record.requestId}`},'_admin','admin',${record.stage === "acknowledged" ? "completed" : "pending"},'{}',${json},0,${terminalAt}) ON CONFLICT(id) DO UPDATE SET admin_json=excluded.admin_json,status=excluded.status,terminal_at=coalesce(memory_outbox.terminal_at,excluded.terminal_at)`,
    );
    return record;
  });
  const readActivatedHubAdminTx: MemoryStore["Service"]["readActivatedHubAdminTx"] = Effect.fn(
    "MemoryStore.readActivatedHubAdminTx",
  )(function* () {
    yield* Transaction;
    const rows = yield* stored(
      "hub-admin-activated",
      sql<{
        admin_json: string;
      }>`SELECT admin_json FROM memory_outbox WHERE kind='admin' AND admin_json IS NOT NULL AND json_extract(admin_json,'$.stage')='activated' ORDER BY id LIMIT 1`,
    );
    return rows[0]
      ? yield* stored("hub-admin-codec", adminCodec.decode(rows[0].admin_json, strict))
      : undefined;
  });
  const readPendingHubAdmins: MemoryStore["Service"]["readPendingHubAdmins"] = Effect.fn(
    "MemoryStore.readPendingHubAdmins",
  )(function* (limit) {
    const rows = yield* stored(
      "hub-admin-pending",
      sql<{
        admin_json: string;
      }>`SELECT admin_json FROM memory_outbox WHERE kind='admin' AND status='pending' AND admin_json IS NOT NULL ORDER BY id LIMIT ${Math.max(0, Math.min(limit, M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS))}`,
    );
    return yield* Effect.forEach(rows, (row) =>
      stored("hub-admin-codec", adminCodec.decode(row.admin_json, strict)),
    );
  });
  const activateHubMemberTx: MemoryStore["Service"]["activateHubMemberTx"] = Effect.fn(
    "MemoryStore.activateHubMemberTx",
  )(function* (input) {
    yield* Transaction;
    const record = yield* readHubAdminTx(input.requestId);
    if (!record || !("action" in record))
      return yield* new MemoryStoreConflict({ code: "revision_changed" });
    if (
      record.requestDigest !== input.requestDigest ||
      (record.action.action === "configure"
        ? record.action.settings.mode !== "hub" ||
          (record.action.settings.memorySpaceId !== null &&
            record.action.settings.memorySpaceId !== input.memorySpaceId)
        : !("environmentId" in record.action) ||
          record.action.environmentId !== input.environmentId)
    )
      return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
    const old = yield* readHubMember(input.memorySpaceId, input.environmentId);
    const expectedAction =
      input.next === "revoked"
        ? "revokeMember"
        : input.expectedCredentialVersion === null
          ? "provisionMember"
          : "rotateMemberCredential";
    if (
      record.action.action !== expectedAction &&
      !(
        record.action.action === "provisionMember" &&
        input.next !== "revoked" &&
        (old?.status === "revoked" || record.memberVersion !== null)
      ) &&
      !(
        record.action.action === "configure" &&
        input.next !== "revoked" &&
        input.expectedCredentialVersion === null
      )
    )
      return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
    if (record.memberVersion !== null) {
      if (
        !old ||
        old.credentialVersion !== record.memberVersion ||
        (input.next === "revoked"
          ? old.status !== "revoked"
          : old.credentialDigest !== input.next.credentialDigest || old.status !== "active")
      )
        return yield* new MemoryStoreConflict({ code: "revision_changed" });
      return old;
    }
    if (
      record.stage !== "prepared" ||
      (old?.credentialVersion ?? null) !== input.expectedCredentialVersion ||
      (input.next === "revoked" && !old)
    )
      return yield* new MemoryStoreConflict({ code: "revision_changed" });
    if (input.next !== "revoked" && !/^[a-f0-9]{64}$/.test(input.next.credentialDigest))
      return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
    // Allocate before reclaiming: this one durable space counter survives deleted
    // identities, seeds from legacy members, and rolls back with activation.
    const versions = yield* stored(
      "hub-member-version",
      sql<{ version: number }>`SELECT max(
        coalesce((SELECT value FROM memory_quota_counters WHERE space=${input.memorySpaceId}
          AND dimension='hub_member_version' AND scope_key=''),0),
        coalesce((SELECT max(credential_version) FROM memory_hub_members WHERE space=${input.memorySpaceId}),0)
      ) AS version`,
    );
    const version = versions[0]!.version + 1;
    if (!Number.isSafeInteger(version))
      return yield* new MemoryStoreConflict({ code: "revision_changed" });
    yield* stored(
      "hub-member-version-write",
      sql`INSERT INTO memory_quota_counters(space,dimension,scope_key,value)
        VALUES (${input.memorySpaceId},'hub_member_version','',${version})
        ON CONFLICT(space,dimension,scope_key) DO UPDATE SET value=excluded.value`,
    );
    const count = yield* stored(
      "hub-member-count",
      sql<{
        count: number;
      }>`SELECT count(*) AS count FROM memory_hub_members WHERE space=${input.memorySpaceId}`,
    );
    if (!old && count[0]!.count >= M.MEMORY_HUB_MAX_MEMBERS) {
      // Older ready revokes already committed both SQL authority and settings.
      // They have no install step; finish them here as well as on the normal path.
      yield* stored(
        "hub-member-settle-revokes",
        sql`UPDATE memory_outbox SET status='completed',terminal_at=coalesce(terminal_at,${input.now}),
          admin_json=json_set(admin_json,'$.stage','acknowledged')
          WHERE kind='admin' AND status='pending' AND json_extract(admin_json,'$.stage')='ready'
            AND json_extract(admin_json,'$.action.action')='revokeMember'
            AND json_extract(admin_json,'$.result.view.settings.memorySpaceId')=${input.memorySpaceId}`,
      );
      // Revoked authority cannot authenticate. Keep any row that still anchors live
      // work. A ready outgoing receipt below the revoked version is already
      // superseded: replay cannot activate or disclose it. Its guard stays bounded.
      yield* stored(
        "hub-member-reclaim",
        sql`DELETE FROM memory_hub_members AS m WHERE m.space=${input.memorySpaceId} AND m.status='revoked'
          AND NOT EXISTS (SELECT 1 FROM memory_outbox o WHERE o.kind='admin' AND o.status!='completed'
            AND ((json_extract(o.admin_json,'$.action.environmentId')=m.environment
              AND NOT (json_extract(o.admin_json,'$.stage')='ready'
                AND json_extract(o.admin_json,'$.action.action') IN ('provisionMember','rotateMemberCredential')
                AND coalesce(json_extract(o.admin_json,'$.memberVersion'),m.credential_version)<m.credential_version))
              OR (json_extract(o.admin_json,'$.action.action')='configure'
                AND json_extract(o.admin_json,'$.stage') IN ('prepared','activated'))))
          AND NOT EXISTS (SELECT 1 FROM memory_hub_leases l WHERE l.space=m.space
            AND json_extract(l.lease_json,'$.holderEnvironmentId')=m.environment
            AND l.lease_json IS NOT NULL)
          AND NOT EXISTS (SELECT 1 FROM memory_hub_retention r,json_each(r.handles_json) h
            WHERE r.space=m.space AND json_extract(h.value,'$.memberEnvironmentId')=m.environment
              AND json_extract(h.value,'$.expiresAt')>${input.now})
          AND NOT EXISTS (SELECT 1 FROM memory_import_keys k WHERE k.space=m.space
            AND k.key_kind='hub_checkpoint_token'
            AND json_extract(k.record_json,'$.handle.memberEnvironmentId')=m.environment
            AND json_extract(k.record_json,'$.retired')=0
            AND json_extract(k.record_json,'$.handle.expiresAt')>${input.now})
          AND NOT EXISTS (SELECT 1 FROM memory_hub_source_reads r WHERE r.space=m.space
            AND (r.requester=m.environment OR r.owner=m.environment)
            AND r.state='pending' AND r.deadline>${input.now})`,
      );
      // Revoke/rotation already expired every relay for these identities. The
      // durable version high-water above prevents reenrollment from reviving them.
      // Keep pair fences only while both member rows exist, in this same writer Tx.
      yield* stored(
        "hub-source-fence-reclaim-owners",
        sql`DELETE FROM memory_import_keys AS f WHERE f.space=${input.memorySpaceId}
          AND f.key_kind='hub_source_fences' AND NOT EXISTS
            (SELECT 1 FROM memory_hub_members m WHERE m.space=f.space AND m.environment=f.key)`,
      );
      yield* stored(
        "hub-source-fence-reclaim-requesters",
        sql`UPDATE memory_import_keys AS f SET record_json=(
          SELECT json_group_array(json(p.value)) FROM json_each(f.record_json) p
          WHERE EXISTS (SELECT 1 FROM memory_hub_members m WHERE m.space=f.space
            AND m.environment=json_extract(p.value,'$.requesterEnvironmentId')))
          WHERE f.space=${input.memorySpaceId} AND f.key_kind='hub_source_fences'`,
      );
      const remaining = yield* stored(
        "hub-member-count-after-reclaim",
        sql<{
          count: number;
        }>`SELECT count(*) AS count FROM memory_hub_members WHERE space=${input.memorySpaceId}`,
      );
      if (remaining[0]!.count >= M.MEMORY_HUB_MAX_MEMBERS)
        return yield* new MemoryCapacityError({
          dimension: "members",
          limit: M.MEMORY_HUB_MAX_MEMBERS,
          current: remaining[0]!.count,
          reclaimable: 0,
        });
    }
    const next: HubMember = {
      memorySpaceId: input.memorySpaceId,
      environmentId: input.environmentId,
      credentialDigest:
        input.next === "revoked" ? old!.credentialDigest : input.next.credentialDigest,
      credentialVersion: version,
      status: input.next === "revoked" ? "revoked" : "active",
      joinedAt: old?.joinedAt ?? input.now,
    };
    yield* stored(
      "hub-member-activate",
      sql`INSERT INTO memory_hub_members(space,environment,credential_digest,credential_version,status,joined_at) VALUES (${next.memorySpaceId},${next.environmentId},${next.credentialDigest},${next.credentialVersion},${next.status},${next.joinedAt}) ON CONFLICT(space,environment) DO UPDATE SET credential_digest=excluded.credential_digest,credential_version=excluded.credential_version,status=excluded.status`,
    );
    // Rotation/revoke fences both ledgers before the new credential can authorize a request.
    const leases = yield* stored(
      "hub-member-leases",
      sql<{
        memory_id: string;
        highest_token: number;
      }>`SELECT memory_id,highest_token FROM memory_hub_leases WHERE space=${input.memorySpaceId} AND json_extract(lease_json,'$.holderEnvironmentId')=${input.environmentId}`,
    );
    for (const lease of leases) {
      const aggregate = yield* loadAggregate(
        input.memorySpaceId,
        M.MemoryId.make(lease.memory_id),
        {},
        {},
      );
      const highest = Math.max(lease.highest_token, aggregate.fence?.highestFencingToken ?? 0) + 1;
      const fence: M.MemoryFenceRecord = {
        memorySpaceId: input.memorySpaceId,
        memoryId: M.MemoryId.make(lease.memory_id),
        highestFencingToken: highest,
        activeLease: null,
      };
      yield* stored(
        "hub-member-invalidate",
        sql`UPDATE memory_hub_leases SET highest_token=${highest},lease_json=NULL WHERE space=${input.memorySpaceId} AND memory_id=${lease.memory_id}`,
      );
      yield* stored(
        "hub-member-fence",
        sql`UPDATE memory_identity_ledger SET fence_json=${yield* fenceCodec.encode(fence)} WHERE space=${input.memorySpaceId} AND memory_id=${lease.memory_id}`,
      );
    }
    const relay = yield* stored(
      "hub-member-relay",
      sql<{
        payload_ref: string | null;
      }>`SELECT payload_ref FROM memory_hub_source_reads WHERE space=${input.memorySpaceId} AND (requester=${input.environmentId} OR owner=${input.environmentId})`,
    );
    for (const row of relay)
      if (row.payload_ref)
        yield* stored(
          "hub-member-relay-purge",
          sql`DELETE FROM memory_payloads WHERE space=${input.memorySpaceId} AND payload_ref=${row.payload_ref}`,
        );
    yield* stored(
      "hub-member-relay-delete",
      sql`UPDATE memory_hub_source_reads SET state='expired',locator_json='{}',payload_ref=NULL WHERE space=${input.memorySpaceId} AND (requester=${input.environmentId} OR owner=${input.environmentId})`,
    );
    const previousHandles = yield* handlesFor(input.memorySpaceId);
    for (const handle of previousHandles.filter(
      (h) => h.memberEnvironmentId === input.environmentId,
    ))
      yield* stored(
        "hub-member-token-retire",
        sql`UPDATE memory_import_keys SET record_json=json_set(record_json,'$.retired',json('true')) WHERE space=${input.memorySpaceId} AND key_kind='hub_checkpoint_token' AND key=${hashText(handle.snapshotToken)}`,
      );
    yield* stored(
      "hub-member-pin-retire",
      sql`UPDATE memory_hub_retention SET handles_json=${yield* handleCodec.encode(previousHandles.filter((h) => h.memberEnvironmentId !== input.environmentId))} WHERE space=${input.memorySpaceId}`,
    );
    if (record.action.action === "configure") {
      // Readiness and internal authority commit together; a nonrepresentable legacy space rolls back.
      const checkpoint = yield* prepareHubCheckpointTx({
        authority: {
          principal: {
            memorySpaceId: input.memorySpaceId,
            environmentId: input.environmentId,
            credentialVersion: next.credentialVersion,
            scopes: ["memory:sync"],
          },
          now: Effect.succeed(input.now),
          reauthorize: Effect.void,
        },
        checkpointId: `initial-${input.requestId}`,
        snapshotToken: `initial-${input.requestId}`,
        hubEnvironmentId: input.environmentId,
      }).pipe(
        Effect.catchTags({
          MemoryHubError: () =>
            Effect.fail(new MemoryStoreConflict({ code: "bootstrap_required" })),
          MemoryHubUnauthorizedError: () =>
            Effect.fail(new MemoryStoreConflict({ code: "identity_mismatch" })),
          MemoryHubForbiddenError: () =>
            Effect.fail(new MemoryStoreConflict({ code: "identity_mismatch" })),
        }),
      );
      yield* publishCheckpointAndFloorTx({
        memorySpaceId: input.memorySpaceId,
        checkpointId: checkpoint.checkpointId,
        expectedFloor: 0,
        nextFloor: checkpoint.checkpointSequence,
        now: input.now,
      });
      yield* stored(
        "hub-internal-pin-retire",
        sql`UPDATE memory_hub_retention SET handles_json='[]' WHERE space=${input.memorySpaceId}`,
      );
      yield* stored(
        "hub-internal-token-retire",
        sql`UPDATE memory_import_keys SET record_json=json_set(record_json,'$.retired',json('true')) WHERE space=${input.memorySpaceId} AND key_kind='hub_checkpoint_token' AND key=${hashText(checkpoint.snapshotToken)}`,
      );
    }
    yield* writeHubAdminTx({
      record: { ...record, stage: "activated", memberVersion: next.credentialVersion },
      expectedStage: "prepared",
    });
    return next;
  });
  const readProcessingFor = Effect.fn("MemoryStore.readProcessingFor")(function* (input: {
    space: string;
    binding: { memorySpaceId: M.MemorySpaceId; hubEnvironmentId: M.EnvironmentId } | null;
  }) {
    return yield* transact(
      Effect.gen(function* () {
        const rows = yield* stored(
          "processing-counters",
          sql<{
            dimension: string;
            value: number;
          }>`SELECT dimension,value FROM memory_quota_counters WHERE space=${input.space} AND scope_key='' AND dimension IN ('processing_quarantined','processing_eligible','processing_indexed','processing_cleanup','processing_scanner_held','processing_scanner_pending','processing_missing_parent','processing_deferred','processing_pending_sync','processing_parked','processing_report_backlog','processing_report_failed','processing_admission_failures')`,
        );
        const values = new Map(rows.map((r) => [r.dimension, r.value]));
        const count = (name: string) => values.get(`processing_${name}`) ?? 0;
        const oldest = yield* stored(
          "processing-oldest",
          sql<{
            processing_oldest_at: string;
          }>`SELECT processing_oldest_at FROM memory_items WHERE space=${input.space} AND processing_oldest_at IS NOT NULL ORDER BY processing_oldest_at LIMIT 1`,
        );
        const sequence = input.binding ? (yield* readBootstrap(input.binding)).afterSequence : 0;
        const state = yield* stored(
          "processing-watermark",
          sql<{
            projection_watermark: number;
          }>`SELECT projection_watermark FROM memory_compaction_state WHERE space=${input.space}`,
        );
        const eligible = count("eligible");
        const indexed = count("indexed");
        const processing = yield* stored(
          "processing-codec",
          codec(M.MemoryProcessingStatus).decode(
            yield* codec(M.MemoryProcessingStatus).encode({
              lastReceivedHubSequence: sequence,
              receiveLag: null,
              deferred: count("deferred"),
              oldestDeferredAtUtc: oldest[0]
                ? M.MemoryUtcTimestamp.make(oldest[0].processing_oldest_at)
                : null,
              unindexedItems: eligible - indexed,
              scannerHeldItems: count("scanner_held"),
              scannerPendingItems: count("scanner_pending"),
              missingParentItems: count("missing_parent"),
              pendingCleanupItems: count("cleanup"),
              reportBacklog: count("report_backlog"),
              reportFailed: count("report_failed"),
              hubAdmissionFailures: count("admission_failures"),
              indexCoverage: {
                status:
                  eligible === indexed ? "available" : indexed === 0 ? "unavailable" : "partial",
                eligibleItems: eligible,
                indexedItems: indexed,
                unindexedItems: eligible - indexed,
                projectionWatermark: state[0]?.projection_watermark ?? 0,
              },
            }),
            strict,
          ),
        );
        return {
          processing,
          pendingSync: count("pending_sync"),
          quarantined: count("quarantined"),
          parked: count("parked"),
        };
      }),
    );
  });
  const readProcessing: MemoryStore["Service"]["readProcessing"] = (input) =>
    readProcessingFor({ space: input.memorySpaceId, binding: input });
  const readLocalProcessingStatus: MemoryStore["Service"]["readLocalProcessingStatus"] = (input) =>
    readProcessingFor({
      // WP2 drafts use an internal key, never a protocol MemorySpaceId or a new space.
      space: input.memorySpaceId ?? `_local:${input.environmentId}`,
      binding:
        input.memorySpaceId !== null && input.hubEnvironmentId !== null
          ? { memorySpaceId: input.memorySpaceId, hubEnvironmentId: input.hubEnvironmentId }
          : null,
    });
  const readBootstrap: MemoryStore["Service"]["readBootstrap"] = Effect.fn(
    "MemoryStore.readBootstrap",
  )(function* (input) {
    const rows = yield* stored(
      "bootstrap-read",
      sql<{
        bootstrap_state: "unbound" | "staging" | "ready";
        checkpoint_id: string | null;
        snapshot_token: string | null;
        checkpoint_sequence: number | null;
        checkpoint_cursor: string | null;
        checkpoint_page_count: number;
        after_sequence: number;
        last_success_at: number | null;
      }>`SELECT bootstrap_state,checkpoint_id,snapshot_token,checkpoint_sequence,checkpoint_cursor,checkpoint_page_count,after_sequence,last_success_at FROM memory_sync_cursors WHERE space=${input.memorySpaceId} AND hub_environment_id=${input.hubEnvironmentId}`,
    );
    const row = rows[0];
    return {
      state: row?.bootstrap_state ?? "unbound",
      checkpointId: row?.checkpoint_id ?? null,
      snapshotToken: row?.snapshot_token ?? null,
      checkpointSequence: row?.checkpoint_sequence ?? 0,
      cursor: row?.checkpoint_cursor ?? null,
      pageCount: row?.checkpoint_page_count ?? 0,
      afterSequence: row?.after_sequence ?? 0,
      lastSuccessAt: row?.last_success_at ?? null,
    };
  });
  const discardBootstrapTx: MemoryStore["Service"]["discardBootstrapTx"] = Effect.fn(
    "MemoryStore.discardBootstrapTx",
  )(function* (input) {
    yield* Transaction;
    const changed = yield* stored(
      "bootstrap-discard-cas",
      sql`UPDATE memory_sync_cursors SET bootstrap_state='unbound',checkpoint_id=NULL,snapshot_token=NULL,checkpoint_sequence=NULL,checkpoint_cursor=NULL,checkpoint_page_count=0,after_sequence=0,last_success_at=NULL WHERE space=${input.memorySpaceId} AND hub_environment_id=${input.hubEnvironmentId} AND bootstrap_state='staging' AND snapshot_token=${input.expectedSnapshotToken} AND checkpoint_id=${input.expectedCheckpointId} AND checkpoint_sequence=${input.expectedCheckpointSequence} RETURNING space`,
    );
    if (!changed.length) return false;
    yield* stored(
      "bootstrap-discard-pages",
      sql`DELETE FROM memory_inbox_pending WHERE space=${input.memorySpaceId} AND checkpoint_id=${input.expectedCheckpointId} AND record_kind='checkpoint'`,
    );
    // Only rows created by this staging attempt are reclaimable. A concurrent
    // canonical receive may already have adopted the same payload reference.
    yield* stored(
      "bootstrap-discard-bodies",
      sql`DELETE FROM memory_payloads WHERE space=${input.memorySpaceId} AND checkpoint_stage_id=${input.expectedCheckpointId} AND NOT EXISTS(SELECT 1 FROM memory_revisions r WHERE r.space=memory_payloads.space AND r.payload_ref=memory_payloads.payload_ref) AND NOT EXISTS(SELECT 1 FROM memory_resolutions r WHERE r.space=memory_payloads.space AND r.judgment_payload_ref=memory_payloads.payload_ref) AND NOT EXISTS(SELECT 1 FROM memory_outbox o WHERE o.space=memory_payloads.space AND o.payload_ref=memory_payloads.payload_ref)`,
    );
    yield* stored(
      "bootstrap-discard-adopted",
      sql`UPDATE memory_payloads SET checkpoint_stage_id=NULL WHERE space=${input.memorySpaceId} AND checkpoint_stage_id=${input.expectedCheckpointId}`,
    );
    return true;
  });
  const retireFrozenClaimTx: MemoryStore["Service"]["retireFrozenClaimTx"] = Effect.fn(
    "MemoryStore.retireFrozenClaimTx",
  )(function* (input) {
    yield* Transaction;
    const rows = yield* stored(
      "frozen-claim-read",
      sql<{
        frozen_claim_json: string;
      }>`SELECT frozen_claim_json FROM memory_outbox WHERE id=${input.candidateId} AND space=${input.memorySpaceId} AND kind='claim' AND sync_version=${input.expectedGeneration} AND frozen_claim_json IS NOT NULL AND status IN ('pending','retry','running')`,
    );
    if (!rows[0]) return false;
    const claim = yield* stored(
      "frozen-claim-decode",
      claimCodec.decode(rows[0].frozen_claim_json, strict),
    );
    if (
      claim.attemptId !== input.attemptId ||
      !sameHeadSet(claim.conflictHeadSet, input.frozenHeads)
    )
      return false;
    const changed = yield* stored(
      "frozen-claim-retire",
      sql`UPDATE memory_outbox SET frozen_claim_json=NULL,sync_version=sync_version+1,status='retry',claimed_by=NULL,claimed_until=NULL,next_attempt_at=${input.nextAttemptAt} WHERE id=${input.candidateId} AND space=${input.memorySpaceId} AND kind='claim' AND sync_version=${input.expectedGeneration} AND frozen_claim_json=${rows[0].frozen_claim_json} AND NOT EXISTS(SELECT 1 FROM memory_outbox t WHERE t.space=${input.memorySpaceId} AND t.kind='resolve' AND json_extract(t.ticket_json,'$.ticket.attemptId')=${input.attemptId}) RETURNING id`,
    );
    return changed.length === 1;
  });
  const advanceBootstrapTx: MemoryStore["Service"]["advanceBootstrapTx"] = Effect.fn(
    "MemoryStore.advanceBootstrapTx",
  )(function* (input) {
    yield* Transaction;
    if (input.expectedState === "unbound" && input.nextState !== "staging")
      return yield* new MemoryStoreConflict({ code: "bootstrap_required" });
    yield* stored(
      "bootstrap-init",
      sql`INSERT INTO memory_sync_cursors(space,hub_environment_id,after_sequence,bootstrap_state) VALUES (${input.memorySpaceId},${input.hubEnvironmentId},0,'unbound') ON CONFLICT(space,hub_environment_id) DO NOTHING`,
    );
    if (input.nextState === "ready") {
      const published = yield* stored(
        "bootstrap-published",
        sql`SELECT 1 FROM memory_compaction_state WHERE space=${input.memorySpaceId} AND checkpoint_id=${input.checkpointId} AND published=1 AND json_extract(boundary_json,'$.checkpointSequence')=${input.checkpointSequence}`,
      );
      if (!published.length || input.nextCursor !== null)
        return yield* new MemoryStoreConflict({ code: "bootstrap_required" });
    }
    const changed = yield* stored(
      "bootstrap-cas",
      sql`UPDATE memory_sync_cursors SET bootstrap_state=${input.nextState},checkpoint_id=${input.checkpointId},snapshot_token=${input.snapshotToken},checkpoint_sequence=${input.checkpointSequence},checkpoint_cursor=${input.nextCursor},after_sequence=CASE WHEN ${input.nextState}='ready' THEN max(after_sequence,${input.checkpointSequence}) ELSE after_sequence END WHERE space=${input.memorySpaceId} AND hub_environment_id=${input.hubEnvironmentId} AND bootstrap_state=${input.expectedState} AND (${input.expectedState}!='staging' OR checkpoint_id=${input.checkpointId} AND snapshot_token IS ${input.snapshotToken} AND checkpoint_sequence=${input.checkpointSequence}) RETURNING space`,
    );
    if (!changed.length) return yield* new MemoryStoreConflict({ code: "revision_changed" });
  });
  const sourceRequestCodec = codec(M.MemorySourceReadRequest);
  const sourceInputCodec = codec(M.MemoryHubSourceReadRequestInput);
  const sourceOutcomeCodec = codec(M.MemorySourceReadOutcome);
  const sourceRespondCodec = codec(M.MemoryHubSourceReadRespondInput);
  const sourceCollectCodec = codec(M.MemoryHubSourceReadCollectResult);
  const sourceThreadCodec = codec(M.ScopedThreadRef);
  const sourceWatermarkCodec = codec(M.MemorySourceWatermark);
  // Relay authority metadata shares the existing body-free replay registry. One
  // bounded map per retained member; membership reclamation prunes both ends.
  const pairFencesCodec = codec(M.MemorySourceReadPairFences);
  const settlementCodec = codec(
    Schema.Struct({
      responseDigest: Schema.NullOr(Schema.String),
      ownerPolicyEpoch: M.MemoryOwnerPolicyEpoch,
      denied: Schema.Boolean,
    }),
  );
  const readPairFences = Effect.fnUntraced(function* (
    space: M.MemorySpaceId,
    owner: M.EnvironmentId,
  ) {
    const rows = yield* stored(
      "relay-pair-fences",
      sql<{
        record_json: string;
      }>`SELECT record_json FROM memory_import_keys WHERE space=${space} AND key_kind='hub_source_fences' AND key=${owner}`,
    );
    const fences = rows[0] ? yield* pairFencesCodec.decode(rows[0].record_json, strict) : [];
    if (fences.some((f) => f.memorySpaceId !== space || f.ownerEnvironmentId !== owner))
      return yield* new M.MemoryHubError({ code: "identity_mismatch" });
    return fences;
  });
  const pairFence = Effect.fnUntraced(function* (space: M.MemorySpaceId, row: RelayRow) {
    return (
      (yield* readPairFences(space, M.EnvironmentId.make(row.owner))).find(
        (f) => f.requesterEnvironmentId === row.requester,
      )?.revokedThroughEpoch ?? -1
    );
  });
  type RelayRow = {
    request_id: string;
    memory_id: string;
    requester: string;
    owner: string;
    credential_version: number;
    request_digest: string;
    locator_json: string;
    state: "pending" | "completed" | "expired";
    deadline: number;
    response_digest: string | null;
    payload_ref: string | null;
  };
  const readRelay = Effect.fnUntraced(function* (
    space: M.MemorySpaceId,
    requestId: M.MemorySourceReadRequestId,
  ) {
    const rows = yield* stored(
      "relay-read",
      sql<RelayRow>`SELECT request_id,memory_id,requester,owner,credential_version,request_digest,locator_json,state,deadline,response_digest,payload_ref FROM memory_hub_source_reads WHERE space=${space} AND request_id=${requestId}`,
    );
    return rows[0];
  });
  const authorizeSource = Effect.fnUntraced(function* (
    authority: HubAuthority,
    space: M.MemorySpaceId,
  ) {
    yield* Transaction;
    yield* authority.reauthorize;
    const member = yield* requireHubMemberTx(authority.principal);
    if (member.memorySpaceId !== space)
      return yield* new M.MemoryHubError({ code: "space_mismatch" });
    return { member, now: yield* authority.now };
  });
  const relayEligible = Effect.fnUntraced(function* (
    space: M.MemorySpaceId,
    request: M.MemorySourceReadRequest,
  ) {
    const aggregate = yield* loadAggregate(space, request.memoryId, { heads: true }, {});
    if (aggregate.tombstone || aggregate.pendingForget) return false;
    if (!aggregate.item || aggregate.item.localAvailability.exposure !== "visible") return false;
    for (const pair of aggregate.revisions) {
      if (!aggregate.heads.includes(pair.revision.revisionId) || !pair.payload) continue;
      const provenance = pair.revision.provenance;
      if (!provenance.sourceThread || !provenance.sourceWatermark) continue;
      if (
        (yield* sourceThreadCodec.encode(provenance.sourceThread)) !==
          (yield* sourceThreadCodec.encode(request.sourceThread)) ||
        (yield* sourceWatermarkCodec.encode(provenance.sourceWatermark)) !==
          (yield* sourceWatermarkCodec.encode(request.sourceWatermark))
      )
        continue;
      const evidence = new Set(
        pair.payload.evidence
          .filter(
            (value) =>
              value.origin === "thread" &&
              value.sourceThread?.environmentId === request.sourceThread.environmentId &&
              value.sourceThread.threadId === request.sourceThread.threadId &&
              value.watermark?.fromEventId === provenance.sourceWatermark?.fromEventId &&
              value.watermark?.toEventId === provenance.sourceWatermark?.toEventId &&
              value.watermark?.throughSequence === provenance.sourceWatermark?.throughSequence,
          )
          .flatMap((value) => value.messageIds),
      );
      if (request.messageIds.every((id) => evidence.has(id))) return true;
    }
    return false;
  });
  const eraseRelayPayload = Effect.fnUntraced(function* (space: M.MemorySpaceId, row: RelayRow) {
    if (row.payload_ref)
      yield* stored(
        "relay-payload-purge",
        sql`DELETE FROM memory_payloads WHERE space=${space} AND payload_ref=${row.payload_ref}`,
      );
    yield* stored(
      "relay-expire",
      sql`UPDATE memory_hub_source_reads SET state='expired',locator_json='{}',payload_ref=NULL WHERE space=${space} AND request_id=${row.request_id}`,
    );
  });
  const settleDenied = Effect.fnUntraced(function* (
    space: M.MemorySpaceId,
    row: RelayRow,
    epoch: number,
  ) {
    if (row.payload_ref)
      yield* stored(
        "relay-denied-purge",
        sql`DELETE FROM memory_payloads WHERE space=${space} AND payload_ref=${row.payload_ref}`,
      );
    yield* stored(
      "relay-denied",
      sql`UPDATE memory_hub_source_reads SET state='completed',payload_ref=NULL,response_digest=${yield* settlementCodec.encode({ responseDigest: null, ownerPolicyEpoch: epoch, denied: true })} WHERE space=${space} AND request_id=${row.request_id}`,
    );
  });
  const relayRequest = Effect.fnUntraced(function* (space: M.MemorySpaceId, row: RelayRow) {
    const request = yield* sourceRequestCodec
      .decode(row.locator_json, strict)
      .pipe(Effect.orElseSucceed(() => null));
    if (
      !request?.stamp ||
      request.memorySpaceId !== space ||
      request.requestId !== row.request_id ||
      request.memoryId !== row.memory_id ||
      request.sourceThread.environmentId !== row.owner ||
      request.requesterEnvironmentId !== row.requester ||
      request.stamp.requesterCredentialVersion !== row.credential_version ||
      request.stamp.locatorDigest !== row.request_digest ||
      Date.parse(request.expiresAtHubTime) !== row.deadline
    )
      return null;
    const {
      stamp: _stamp,
      requesterEnvironmentId: _requester,
      expiresAtHubTime: _expiry,
      ...locator
    } = request;
    const digest = hashText(yield* sourceInputCodec.encode({ protocolVersion: 1, ...locator }));
    return digest === row.request_digest ? request : null;
  });
  const compactTerminalAdmins = Effect.fnUntraced(function* (now: number, limit: number) {
    const rows = yield* stored(
      "hub-admin-sweep",
      sql<{
        id: string;
        admin_json: string;
      }>`SELECT id,admin_json FROM memory_outbox WHERE kind='admin' AND status='completed' AND terminal_at<=${now - M.MEMORY_LOG_RETENTION_MS} AND json_extract(admin_json,'$.stage')='acknowledged' ORDER BY terminal_at,id LIMIT ${limit + 1}`,
    );
    for (const row of rows.slice(0, limit)) {
      const record = yield* adminCodec.decode(row.admin_json, strict);
      yield* stored(
        "hub-admin-guard",
        sql`INSERT INTO memory_import_keys(space,key_kind,key,memory_id,record_json) VALUES ('_admin','hub_admin',${record.requestId},${record.requestId},${yield* adminReplayJson(record)}) ON CONFLICT(space,key_kind,key) DO NOTHING`,
      );
      yield* stored("hub-admin-detail-retire", sql`DELETE FROM memory_outbox WHERE id=${row.id}`);
    }
    return { removedRows: Math.min(rows.length, limit), cleanupPending: rows.length > limit };
  });
  const purgeHubTransientTx: MemoryStore["Service"]["purgeHubTransientTx"] = Effect.fn(
    "MemoryStore.purgeHubTransientTx",
  )(function* (input) {
    yield* Transaction;
    const limit = Math.max(0, Math.min(input.limit, M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS));
    const rows = yield* stored(
      "relay-sweep",
      sql<RelayRow>`SELECT request_id,memory_id,requester,owner,credential_version,request_digest,locator_json,state,deadline,response_digest,payload_ref FROM memory_hub_source_reads WHERE space=${input.memorySpaceId} AND (deadline<=${input.now} OR (${input.memoryId ?? null} IS NOT NULL AND memory_id=${input.memoryId ?? null})) ORDER BY deadline,request_id LIMIT ${limit + 1}`,
    );
    for (const row of rows.slice(0, limit)) {
      yield* eraseRelayPayload(input.memorySpaceId, row);
      yield* stored(
        "relay-sweep-delete",
        sql`DELETE FROM memory_hub_source_reads WHERE space=${input.memorySpaceId} AND request_id=${row.request_id}`,
      );
    }
    const retention = yield* readHubRetentionTx(input.memorySpaceId);
    const handles = (yield* handlesFor(input.memorySpaceId)).filter((h) => h.expiresAt > input.now);
    const keep = [
      ...new Set([
        ...(retention.checkpointId ? [snapshotId(retention.checkpointId)] : []),
        ...handles.map((h) => snapshotId(h.checkpointId)),
      ]),
    ];
    const remaining = Math.max(0, limit - Math.min(rows.length, limit));
    const pages = yield* stored(
      "hub-transient-snapshots",
      sql<{
        pending_key: string;
        bytes: number;
      }>`SELECT pending_key,length(CAST(metadata_json AS BLOB)) AS bytes FROM memory_inbox_pending WHERE space=${input.memorySpaceId} AND reason='hub_snapshot' AND checkpoint_id NOT IN (SELECT value FROM json_each(${yield* stringArrayCodec.encode(keep)})) ORDER BY pending_key LIMIT ${remaining + 1}`,
    );
    let released = 0;
    for (const page of pages.slice(0, remaining)) {
      yield* stored(
        "hub-transient-snapshot-delete",
        sql`DELETE FROM memory_inbox_pending WHERE space=${input.memorySpaceId} AND pending_key=${page.pending_key}`,
      );
      released += page.bytes;
    }
    yield* stored(
      "hub-transient-pin-release",
      sql`UPDATE memory_hub_retention SET handles_json=${yield* handleCodec.encode(handles)},published_pinned_bytes=max(0,published_pinned_bytes-${released}) WHERE space=${input.memorySpaceId}`,
    );
    const admins = yield* compactTerminalAdmins(
      input.now,
      Math.max(0, remaining - Math.min(pages.length, remaining)),
    );
    return {
      removedRows:
        Math.min(rows.length, limit) + Math.min(pages.length, remaining) + admins.removedRows,
      cleanupPending: rows.length > limit || pages.length > remaining || admins.cleanupPending,
    };
  });
  const requestHubSourceReadTx: MemoryStore["Service"]["requestHubSourceReadTx"] = Effect.fn(
    "MemoryStore.requestHubSourceReadTx",
  )(function* (authority, input) {
    const { member, now } = yield* authorizeSource(authority, input.memorySpaceId);
    const encoded = yield* sourceInputCodec.encode(input);
    const requestDigest = hashText(encoded);
    const old = yield* readRelay(input.memorySpaceId, input.requestId);
    if (old) {
      if (
        old.request_digest !== requestDigest ||
        old.requester !== member.environmentId ||
        old.credential_version !== member.credentialVersion
      )
        return yield* new M.MemoryHubError({ code: "operation_id_reused" });
      if (old.deadline <= now || old.state === "expired")
        return yield* new M.MemoryHubError({ code: "source_unavailable" });
      const request = yield* relayRequest(input.memorySpaceId, old);
      if (!request) {
        yield* settleDenied(input.memorySpaceId, old, 0);
        return yield* new M.MemoryHubError({ code: "source_unavailable" });
      }
      return { request };
    }
    const owner = yield* readHubMember(input.memorySpaceId, input.sourceThread.environmentId);
    if (!owner || owner.status !== "active")
      return yield* new M.MemoryHubError({ code: "source_unavailable" });
    const request: M.MemorySourceReadRequest = {
      ...input,
      requesterEnvironmentId: member.environmentId,
      expiresAtHubTime: M.MemoryUtcTimestamp.make(
        DateTime.formatIso(DateTime.makeUnsafe(now + M.MEMORY_SOURCE_READ_TIMEOUT_MS)),
      ),
    };
    // protocolVersion belongs to transport input, not the persisted owner locator.
    const locator: M.MemorySourceReadRequest = {
      requestId: request.requestId,
      memorySpaceId: request.memorySpaceId,
      memoryId: request.memoryId,
      sourceThread: request.sourceThread,
      sourceWatermark: request.sourceWatermark,
      messageIds: request.messageIds,
      limit: request.limit,
      ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
      authorizedScopes: request.authorizedScopes,
      requesterEnvironmentId: request.requesterEnvironmentId,
      stamp: { requesterCredentialVersion: member.credentialVersion, locatorDigest: requestDigest },
      expiresAtHubTime: request.expiresAtHubTime,
    };
    if (!(yield* relayEligible(input.memorySpaceId, locator)))
      return yield* new M.MemoryHubError({ code: "source_invalidated" });
    yield* purgeHubTransientTx({
      memorySpaceId: input.memorySpaceId,
      now,
      limit: M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS,
    });
    const counts = yield* stored(
      "relay-count",
      sql<{
        total: number;
        member: number;
      }>`SELECT count(*) AS total,sum(CASE WHEN requester=${member.environmentId} THEN 1 ELSE 0 END) AS member FROM memory_hub_source_reads WHERE space=${input.memorySpaceId}`,
    );
    if (
      counts[0]!.total >= M.MEMORY_SOURCE_READ_MAX_PER_HUB ||
      (counts[0]!.member ?? 0) >= M.MEMORY_SOURCE_READ_MAX_PER_ENVIRONMENT
    )
      return yield* new MemoryCapacityError({
        dimension:
          counts[0]!.total >= M.MEMORY_SOURCE_READ_MAX_PER_HUB ? "relay_hub" : "relay_environment",
        limit:
          counts[0]!.total >= M.MEMORY_SOURCE_READ_MAX_PER_HUB
            ? M.MEMORY_SOURCE_READ_MAX_PER_HUB
            : M.MEMORY_SOURCE_READ_MAX_PER_ENVIRONMENT,
      });
    yield* stored(
      "relay-request",
      sql`INSERT INTO memory_hub_source_reads(space,request_id,memory_id,requester,owner,credential_version,request_digest,locator_json,state,deadline) VALUES (${input.memorySpaceId},${input.requestId},${input.memoryId},${member.environmentId},${owner.environmentId},${member.credentialVersion},${requestDigest},${yield* sourceRequestCodec.encode(locator)},'pending',${now + M.MEMORY_SOURCE_READ_TIMEOUT_MS})`,
    );
    return { request: locator };
  });
  const collectHubSourceReadsTx: MemoryStore["Service"]["collectHubSourceReadsTx"] = Effect.fn(
    "MemoryStore.collectHubSourceReadsTx",
  )(function* (authority, input) {
    const { member, now } = yield* authorizeSource(authority, input.memorySpaceId);
    yield* purgeHubTransientTx({
      memorySpaceId: input.memorySpaceId,
      now,
      limit: M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS,
    });
    const rows = yield* stored(
      "relay-collect",
      sql<RelayRow>`SELECT request_id,memory_id,requester,owner,credential_version,request_digest,locator_json,state,deadline,response_digest,payload_ref FROM memory_hub_source_reads WHERE space=${input.memorySpaceId} AND owner=${member.environmentId} AND state='pending' AND deadline>${now} ORDER BY deadline,request_id LIMIT ${Math.max(1, Math.min(input.limit, 32))}`,
    );
    const requests: M.MemorySourceReadRequest[] = [];
    for (const row of rows) {
      const requester = yield* readHubMember(
        input.memorySpaceId,
        M.EnvironmentId.make(row.requester),
      );
      const request = yield* relayRequest(input.memorySpaceId, row);
      if (!request) {
        yield* settleDenied(input.memorySpaceId, row, 0);
        continue;
      }
      if (
        !requester ||
        requester.status !== "active" ||
        requester.credentialVersion !== row.credential_version ||
        !(yield* relayEligible(input.memorySpaceId, request))
      ) {
        yield* eraseRelayPayload(input.memorySpaceId, row);
        continue;
      }
      const next = [...requests, request];
      const encoded = yield* Effect.forEach(next, (value) => sourceRequestCodec.encode(value));
      const bytes = new TextEncoder().encode(`{"requests":[${encoded.join(",")}]}`).length;
      if (bytes > M.MEMORY_SOURCE_READ_OUTCOME_MAX_BYTES) break;
      requests.push(request);
    }
    return yield* sourceCollectCodec.decode(yield* sourceCollectCodec.encode({ requests }), strict);
  });
  const respondHubSourceReadTx: MemoryStore["Service"]["respondHubSourceReadTx"] = Effect.fn(
    "MemoryStore.respondHubSourceReadTx",
  )(function* (authority, input) {
    const { member, now } = yield* authorizeSource(authority, input.memorySpaceId);
    if (input.kind === "revoke") {
      const requester = yield* readHubMember(input.memorySpaceId, input.requesterEnvironmentId);
      if (!requester) {
        // An absent identity has no authority. Reclamation only runs after saving
        // this space high-water; future credentials exceed every retired version.
        // No pair fence is needed: old relays fail membership/version checks and
        // the owner's committed removal still denies reads after reenrollment.
        const versions = yield* stored(
          "relay-absent-member-fence",
          sql<{ value: number }>`SELECT value FROM memory_quota_counters
            WHERE space=${input.memorySpaceId} AND dimension='hub_member_version' AND scope_key=''`,
        );
        const highWater = versions[0]?.value;
        if (highWater === undefined || !Number.isSafeInteger(highWater) || highWater <= 0)
          return yield* new M.MemoryHubError({ code: "identity_mismatch" });
        return {
          kind: "revoke" as const,
          accepted: true as const,
          ack: {
            memorySpaceId: input.memorySpaceId,
            ownerEnvironmentId: member.environmentId,
            requesterEnvironmentId: input.requesterEnvironmentId,
            removalEpoch: input.ownerPolicyEpoch,
            revokedThroughEpoch: input.ownerPolicyEpoch,
          },
        };
      }
      const fences = yield* readPairFences(input.memorySpaceId, member.environmentId);
      const previous = fences.find(
        (f) => f.requesterEnvironmentId === input.requesterEnvironmentId,
      );
      const epoch = Math.max(previous?.revokedThroughEpoch ?? -1, input.ownerPolicyEpoch);
      if (!previous || epoch > previous.revokedThroughEpoch) {
        const next = [
          ...fences.filter((f) => f.requesterEnvironmentId !== input.requesterEnvironmentId),
          {
            memorySpaceId: input.memorySpaceId,
            ownerEnvironmentId: member.environmentId,
            requesterEnvironmentId: input.requesterEnvironmentId,
            revokedThroughEpoch: epoch,
          },
        ];
        const json = yield* pairFencesCodec.encode(next);
        yield* stored(
          "relay-pair-revoke",
          sql`INSERT INTO memory_import_keys(space,key_kind,key,memory_id,record_json) VALUES (${input.memorySpaceId},'hub_source_fences',${member.environmentId},${input.memorySpaceId},${json}) ON CONFLICT(space,key_kind,key) DO UPDATE SET record_json=excluded.record_json`,
        );
        const rows = yield* stored(
          "relay-pair-settle",
          sql<RelayRow>`SELECT request_id,memory_id,requester,owner,credential_version,request_digest,locator_json,state,deadline,response_digest,payload_ref FROM memory_hub_source_reads WHERE space=${input.memorySpaceId} AND owner=${member.environmentId} AND requester=${input.requesterEnvironmentId} AND state IN ('pending','completed') ORDER BY request_id LIMIT ${M.MEMORY_SOURCE_READ_MAX_PER_HUB + 1}`,
        );
        if (rows.length > M.MEMORY_SOURCE_READ_MAX_PER_HUB)
          return yield* new M.MemoryHubError({ code: "capacity_exceeded" });
        for (const row of rows) yield* settleDenied(input.memorySpaceId, row, epoch);
      }
      return {
        kind: "revoke" as const,
        accepted: true as const,
        ack: {
          memorySpaceId: input.memorySpaceId,
          ownerEnvironmentId: member.environmentId,
          requesterEnvironmentId: input.requesterEnvironmentId,
          removalEpoch: input.ownerPolicyEpoch,
          revokedThroughEpoch: epoch,
        },
      };
    }
    const row = yield* readRelay(input.memorySpaceId, input.requestId);
    if (!row || row.owner !== member.environmentId)
      return yield* new M.MemoryHubError({ code: "identity_mismatch" });
    const requester = yield* readHubMember(
      input.memorySpaceId,
      M.EnvironmentId.make(row.requester),
    );
    if (
      row.deadline <= now ||
      row.state === "expired" ||
      !requester ||
      requester.status !== "active" ||
      requester.credentialVersion !== row.credential_version
    ) {
      yield* eraseRelayPayload(input.memorySpaceId, row);
      return { kind: "normal" as const, accepted: false };
    }
    const request = yield* relayRequest(input.memorySpaceId, row);
    if (!request) {
      yield* settleDenied(input.memorySpaceId, row, 0);
      return { kind: "normal" as const, accepted: false };
    }
    const previous = row.response_digest
      ? yield* settlementCodec
          .decode(row.response_digest, strict)
          .pipe(Effect.orElseSucceed(() => null))
      : null;
    const responseDigest = hashText(yield* sourceRespondCodec.encode(input));
    if (previous?.denied && previous.responseDigest === responseDigest)
      return { kind: "normal" as const, accepted: true };
    if (
      previous?.denied ||
      (input.outcome.kind === "available" && input.ownerPolicyEpoch === 0) ||
      input.ownerPolicyEpoch <= (yield* pairFence(input.memorySpaceId, row))
    ) {
      yield* settleDenied(
        input.memorySpaceId,
        row,
        Math.max(input.ownerPolicyEpoch, previous?.ownerPolicyEpoch ?? 0),
      );
      return { kind: "normal" as const, accepted: false };
    }
    if (!(yield* relayEligible(input.memorySpaceId, request))) {
      yield* eraseRelayPayload(input.memorySpaceId, row);
      return { kind: "normal" as const, accepted: false };
    }
    if (row.response_digest) {
      if (previous?.responseDigest !== responseDigest)
        return yield* new M.MemoryHubError({ code: "operation_id_reused" });
      return { kind: "normal" as const, accepted: row.state === "completed" };
    }
    if (
      input.outcome.kind === "available" &&
      ((yield* sourceThreadCodec.encode(input.outcome.page.sourceThread)) !==
        (yield* sourceThreadCodec.encode(request.sourceThread)) ||
        (yield* sourceWatermarkCodec.encode(input.outcome.page.watermark)) !==
          (yield* sourceWatermarkCodec.encode(request.sourceWatermark)) ||
        input.outcome.page.messages.length > request.limit ||
        input.outcome.page.messages.some((m) => !request.messageIds.includes(m.messageId)))
    )
      return yield* new M.MemoryHubError({ code: "source_invalidated" });
    const outcome: M.MemorySourceReadOutcome =
      scanMemoryValue(input.outcome).kind === "allowed"
        ? input.outcome
        : { kind: "unavailable", code: "secret_detected" };
    const json = yield* sourceOutcomeCodec.encode(outcome);
    const payloadRef = `relay:${input.requestId}`;
    // A transient body has no revision, event, report, checkpoint or FTS reference.
    if (outcome.kind !== "denied")
      yield* stored(
        "relay-response-payload",
        sql`INSERT INTO memory_payloads(space,payload_ref,memory_id,body_json,dependencies_json,purge_eligible_after) VALUES (${input.memorySpaceId},${payloadRef},${request.memoryId},${json},'[]',${row.deadline})`,
      );
    yield* stored(
      "relay-response",
      sql`UPDATE memory_hub_source_reads SET state='completed',response_digest=${yield* settlementCodec.encode({ responseDigest, ownerPolicyEpoch: input.ownerPolicyEpoch, denied: outcome.kind === "denied" })},payload_ref=${outcome.kind === "denied" ? null : payloadRef} WHERE space=${input.memorySpaceId} AND request_id=${input.requestId}`,
    );
    return { kind: "normal" as const, accepted: true };
  });
  const resultHubSourceReadTx: MemoryStore["Service"]["resultHubSourceReadTx"] = Effect.fn(
    "MemoryStore.resultHubSourceReadTx",
  )(function* (authority, input) {
    const { member, now } = yield* authorizeSource(authority, input.memorySpaceId);
    const row = yield* readRelay(input.memorySpaceId, input.requestId);
    if (!row) return { state: "expired", code: "source_unavailable" };
    if (
      row.requester !== member.environmentId ||
      row.credential_version !== member.credentialVersion
    )
      return yield* new M.MemoryHubError({ code: "identity_mismatch" });
    const owner = yield* readHubMember(input.memorySpaceId, M.EnvironmentId.make(row.owner));
    if (row.deadline <= now || row.state === "expired" || !owner || owner.status !== "active") {
      yield* eraseRelayPayload(input.memorySpaceId, row);
      return { state: "expired", code: "source_unavailable" };
    }
    const settlement = row.response_digest
      ? yield* settlementCodec
          .decode(row.response_digest, strict)
          .pipe(Effect.orElseSucceed(() => null))
      : null;
    if (
      settlement?.denied ||
      (settlement && settlement.ownerPolicyEpoch <= (yield* pairFence(input.memorySpaceId, row)))
    ) {
      yield* settleDenied(input.memorySpaceId, row, settlement.ownerPolicyEpoch);
      return {
        state: "completed",
        outcome: { kind: "denied", requiredPermission: "orchestration:read" },
      };
    }
    const request = yield* relayRequest(input.memorySpaceId, row);
    if (!request || (row.state === "completed" && !settlement)) {
      yield* settleDenied(input.memorySpaceId, row, 0);
      return {
        state: "completed",
        outcome: { kind: "denied", requiredPermission: "orchestration:read" },
      };
    }
    if (!(yield* relayEligible(input.memorySpaceId, request))) {
      yield* eraseRelayPayload(input.memorySpaceId, row);
      return { state: "completed", outcome: { kind: "unavailable", code: "source_invalidated" } };
    }
    if (row.state === "pending")
      return { state: "pending", expiresAtHubTime: request.expiresAtHubTime };
    const bodies = yield* stored(
      "relay-result",
      sql<{
        body_json: string;
      }>`SELECT body_json FROM memory_payloads WHERE space=${input.memorySpaceId} AND payload_ref=${row.payload_ref}`,
    );
    if (!bodies[0]) {
      yield* eraseRelayPayload(input.memorySpaceId, row);
      return { state: "expired", code: "source_unavailable" };
    }
    const outcome = yield* sourceOutcomeCodec.decode(bodies[0].body_json, strict);
    yield* eraseRelayPayload(input.memorySpaceId, row);
    return { state: "completed", outcome };
  });
  const hubReceiptDecode = Schema.decodeUnknownEffect(M.MemoryHubReceipt);
  const hubEntryDecode = Schema.decodeUnknownEffect(M.MemoryHubEntry);
  const submissionDecode = Schema.decodeUnknownEffect(M.MemoryHubApplyResolutionInput);
  const readHubReceiptTx: MemoryStore["Service"]["readHubReceiptTx"] = Effect.fn(
    "MemoryStore.readHubReceiptTx",
  )(function* (space, operationId) {
    yield* Transaction;
    const rows = yield* stored(
      "hub-receipt",
      sql<{
        entry_json: string;
        committed_at: number;
      }>`SELECT entry_json,committed_at FROM memory_hub_operations WHERE space=${space} AND operation_id=${operationId}`,
    );
    if (rows[0])
      return {
        entry: yield* stored("hub-entry", hubEntryCodec.decode(rows[0].entry_json, strict)),
        committedAt: rows[0].committed_at,
      };
    const compact = yield* stored(
      "hub-compact-receipt",
      sql<{
        compact_json: string;
      }>`SELECT compact_json FROM memory_compact_receipts WHERE space=${space} AND operation_id=${operationId}`,
    );
    if (!compact[0]) return undefined;
    const record = yield* stored(
      "hub-compact",
      compactCodec.decode(compact[0].compact_json, strict),
    );
    const entry: M.MemoryHubEntry = {
      kind: "metadata",
      operationKind: record.operationKind,
      hubSequence: record.receipt.hubSequence!,
      memoryId: record.receipt.memoryId,
      receipt: record.receipt,
      compactReceipt: record,
      ...(record.operationKind === "resolve" && record.resolutionId
        ? { resolutionId: record.resolutionId }
        : {}),
    };
    return {
      entry,
      committedAt: record.receipt.resolutionApproval
        ? Date.parse(record.receipt.resolutionApproval.appliedAtUtc)
        : 0,
    };
  });
  const emptyCompaction: M.MemoryCompactionStatus = {
    lastRunAtUtc: null,
    removedRows: 0,
    reclaimedLogicalBytes: 0,
    reclaimableLogicalBytes: 0,
    blockedReasons: [],
  };
  const compactionCodec = codec(M.MemoryCompactionStatus);
  const readHubRetentionTx: MemoryStore["Service"]["readHubRetentionTx"] = Effect.fn(
    "MemoryStore.readHubRetentionTx",
  )(function* (space) {
    yield* Transaction;
    const rows = yield* stored(
      "hub-retention",
      sql<{
        checkpoint_id: string | null;
        checkpoint_sequence: number;
        retention_floor: number;
        boundary_json: string | null;
        compaction_json: string | null;
      }>`SELECT * FROM memory_hub_retention WHERE space=${space}`,
    );
    const row = rows[0];
    return {
      memorySpaceId: space,
      checkpointId: row?.checkpoint_id ?? null,
      checkpointSequence: row?.checkpoint_sequence ?? 0,
      retentionFloor: row?.retention_floor ?? 0,
      causalBoundary: row?.boundary_json
        ? yield* boundaryCodec.decode(row.boundary_json, strict)
        : null,
      compaction: row?.compaction_json
        ? yield* compactionCodec.decode(row.compaction_json, strict)
        : emptyCompaction,
    };
  });
  const cursorFor = (id: string, ordinal: number) => hashText(`${id}:${ordinal}`);
  const buildHubSnapshot = Effect.fnUntraced(function* (
    space: M.MemorySpaceId,
    sequence: number,
    floor: number,
    id: string,
    now: number,
  ) {
    yield* requireImportLineageCompleteTx(space);
    const blank = (ordinal: number): M.MemoryHubCheckpointPage => ({
      memorySpaceId: space,
      checkpointSequence: sequence,
      retentionFloor: floor,
      causalBoundary: {
        checkpointSequence: sequence,
        boundaryId: hashText(`${space}:${id}:${sequence}`),
      },
      pageOrdinal: ordinal,
      items: [],
      revisions: [],
      tombstones: [],
      conflicts: [],
      resolutions: [],
      compactReceipts: [],
      identities: [],
      fences: [],
      suppressions: [],
      importLineage: [],
      nextCursor: cursorFor(id, ordinal + 1),
      bootstrapComplete: false,
    });
    const all = emptyCheckpointInventory();
    const ledger = yield* stored(
      "hub-snapshot-ledger",
      sql<{
        compact_json: string;
      }>`SELECT compact_json FROM memory_compact_receipts WHERE space=${space} AND hub_sequence<=${sequence} ORDER BY operation_id`,
    );
    const receipts = yield* Effect.forEach(ledger, (row) =>
      compactCodec.decode(row.compact_json, strict),
    );
    const approved = new Set(
      receipts.filter((r) => r.receipt.outcome !== "rejected").map((r) => r.receipt.operationId),
    );
    // A joining member also needs body-free revision identity for the reverse
    // forget closure, even after the dependency is no longer a head.
    const lineageRows = yield* stored(
      "hub-snapshot-lineage",
      sql<{
        revision_id: string;
      }>`SELECT DISTINCT r.revision_id FROM memory_payloads p, json_each(p.dependencies_json) d JOIN memory_revisions r ON r.space=p.space AND r.revision_id=d.value WHERE p.space=${space}`,
    );
    const lineage = new Set(lineageRows.map((row) => M.MemoryRevisionId.make(row.revision_id)));
    const identities = yield* stored(
      "hub-snapshot-identities",
      sql<{
        memory_id: string;
      }>`SELECT memory_id FROM memory_identity_ledger WHERE space=${space} ORDER BY memory_id`,
    );
    for (const row of identities) {
      const current = yield* stored(
        "hub-snapshot-inventory",
        selectCheckpointMemory(space, M.MemoryId.make(row.memory_id), now, true, lineage).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
        ),
      );
      const identity = current.identities[0];
      if (
        !identity ||
        !current.fences[0] ||
        !receipts.some(
          (r) =>
            r.receipt.operationId === identity.createOperationId &&
            r.receipt.memoryId === identity.memoryId &&
            (r.receipt.outcome === "accepted" ||
              r.receipt.outcome === "conflicted" ||
              (r.operationKind === "forget" &&
                r.receipt.outcome === "deleted" &&
                current.tombstones[0]?.deleteOperationId === r.receipt.operationId)),
        )
      )
        return yield* new MemoryStoreConflict({ code: "bootstrap_required" });
      if (
        current.tombstones.some((t) => !approved.has(t.deleteOperationId)) ||
        current.revisions.some((p) => !approved.has(p.revision.operationId))
      )
        return yield* new MemoryStoreConflict({ code: "bootstrap_required" });
      if (
        current.resolutions.some(
          ({ resolution }) =>
            !receipts.some(
              (r) =>
                r.operationKind === "resolve" &&
                r.resolutionId === resolution.resolutionId &&
                r.receipt.resolutionApproval,
            ),
        )
      )
        return yield* new MemoryStoreConflict({ code: "unsupported_protocol" });
      // Arrays share the selector and literal-record encoder with admission accounting.
      all.items.push(...current.items);
      all.revisions.push(...current.revisions);
      all.tombstones.push(...current.tombstones);
      all.conflicts.push(...current.conflicts);
      all.resolutions.push(...current.resolutions);
      all.identities.push(...current.identities);
      all.fences.push(...current.fences);
      all.suppressions.push(...current.suppressions);
      all.importLineage.push(...current.importLineage);
    }
    const lineageCount = yield* stored(
      "hub-snapshot-lineage-complete",
      sql<{
        count: number;
      }>`SELECT count(*) AS count FROM memory_import_lineage WHERE space=${space}`,
    );
    if (all.importLineage.length !== lineageCount[0]!.count)
      return yield* new MemoryStoreConflict({ code: "bootstrap_required" });
    all.compactReceipts = receipts;
    const keys = checkpointKeys;
    const pages: M.MemoryHubCheckpointPage[] = [];
    let page = blank(0);
    let count = 0;
    // Measure the complete pull envelope with the longest continuation before accepting a record.
    const pageSize = (value: M.MemoryHubCheckpointPage) =>
      codec(M.MemoryHubPullResult)
        .encode({
          highWatermark: sequence,
          throughSequence: sequence,
          hasMore: true,
          entries: [],
          checkpoint: value,
        })
        .pipe(Effect.map((json) => new TextEncoder().encode(json).length));
    for (const key of keys)
      for (const record of all[key]) {
        const next = { ...page, [key]: [...page[key], record] };
        const size = yield* pageSize(next).pipe(Effect.option);
        if (count === 100 || Option.isNone(size)) {
          if (count === 0) return yield* new MemoryStoreConflict({ code: "payload_too_large" });
          pages.push(page);
          page = blank(pages.length);
          count = 0;
        }
        page = { ...page, [key]: [...page[key], record] };
        yield* pageSize(page);
        count++;
      }
    page = { ...page, bootstrapComplete: true, nextCursor: null };
    pages.push(page);
    if (!M.validateMemoryCheckpointRecords(pages))
      return yield* new MemoryStoreConflict({ code: "bootstrap_required" });
    return pages;
  });
  // Both producers and member joins stage the same complete immutable snapshot. Only joins issue handles.
  const stageHubSnapshotTx = Effect.fnUntraced(function* (
    space: M.MemorySpaceId,
    checkpointId: string,
    now: number,
  ) {
    yield* Transaction;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(checkpointId))
      return yield* new M.MemoryHubError({ code: "invalid_cursor" });
    const retention = yield* readHubRetentionTx(space);
    const rows = yield* stored(
      "hub-snapshot-sequence",
      sql<{
        sequence: number;
      }>`SELECT coalesce(max(hub_sequence),0) AS sequence FROM memory_hub_operations WHERE space=${space}`,
    );
    const sequence = Math.max(rows[0]!.sequence, retention.checkpointSequence);
    let pages = yield* snapshotPages(space, checkpointId);
    const builtNewSnapshot = pages.length === 0;
    if (builtNewSnapshot) {
      pages = yield* buildHubSnapshot(space, sequence, retention.retentionFloor, checkpointId, now);
      const encoded = yield* Effect.forEach(pages, (page) => checkpointCodec.encode(page));
      const bytes = encoded.reduce((sum, json) => sum + new TextEncoder().encode(json).length, 0);
      const usage = yield* readHubUsageTx(space);
      if (bytes > usage.requiredCheckpointBoundBytes)
        return yield* new MemoryStorageError({
          stage: "checkpoint-bound-underflow",
          cause: undefined,
        });
      yield* reserveHubCheckpointTx({
        memorySpaceId: space,
        checkpointDeltaBytes: bytes - usage.checkpointBytes,
        publishedPinnedDeltaBytes: bytes,
      });
      yield* stored(
        "hub-snapshot-size",
        sql`UPDATE memory_hub_retention SET last_snapshot_bytes=${bytes} WHERE space=${space}`,
      );
      for (let ordinal = 0; ordinal < pages.length; ordinal++)
        yield* stored(
          "hub-snapshot-stage",
          sql`INSERT INTO memory_inbox_pending(space,pending_key,record_kind,missing_parents_json,reason,hub_sequence,checkpoint_id,page_ordinal,metadata_json) VALUES (${space},${`${snapshotId(checkpointId)}:${ordinal}`},'checkpoint','[]','hub_snapshot',${sequence},${snapshotId(checkpointId)},${ordinal},${encoded[ordinal]!})`,
        );
    }
    const first = pages[0]!;
    // Unpublished, unpinned producer staging can consume the reserved slot: input writers reclaim it atomically.
    // Publishing or issuing a handle makes the pages retained bytes and requires admission for the lost credit.
    if (builtNewSnapshot)
      yield* stored(
        "hub-snapshot-reservation-consumed",
        sql`UPDATE memory_hub_retention SET reserved_snapshot_id=${checkpointId},last_snapshot_bytes=(SELECT coalesce(sum(length(CAST(metadata_json AS BLOB))),0) FROM memory_inbox_pending WHERE space=${space} AND reason='hub_snapshot' AND checkpoint_id=${snapshotId(checkpointId)}),snapshot_generation=coalesce((SELECT value FROM memory_quota_counters WHERE space=${space} AND dimension='hub_snapshot_generation' AND scope_key=''),0) WHERE space=${space}`,
      );
    return { pages, first };
  });
  const prepareHubProducerCheckpointTx: MemoryStore["Service"]["prepareHubProducerCheckpointTx"] =
    Effect.fn("MemoryStore.prepareHubProducerCheckpointTx")(function* (input) {
      const space = input.authority.principal.memorySpaceId;
      const { member, now } = yield* authorizeSource(input.authority, space);
      if (member.environmentId !== input.hubEnvironmentId)
        return yield* new M.MemoryHubForbiddenError({});
      const { first } = yield* stageHubSnapshotTx(space, input.checkpointId, now);
      return { checkpointId: input.checkpointId, checkpointSequence: first.checkpointSequence };
    });
  const prepareHubCheckpointTx: MemoryStore["Service"]["prepareHubCheckpointTx"] = Effect.fn(
    "MemoryStore.prepareHubCheckpointTx",
  )(function* (input) {
    const space = input.authority.principal.memorySpaceId;
    const { member, now } = yield* authorizeSource(input.authority, space);
    if (
      !/^[A-Za-z0-9_-]{1,128}$/.test(input.checkpointId) ||
      !/^[A-Za-z0-9_-]{1,256}$/.test(input.snapshotToken)
    )
      return yield* new M.MemoryHubError({ code: "invalid_cursor" });
    const handles = yield* handlesFor(space);
    const replay = handles.find((h) => h.snapshotToken === input.snapshotToken);
    if (replay) {
      if (
        replay.memberEnvironmentId !== member.environmentId ||
        replay.credentialVersion !== member.credentialVersion ||
        replay.checkpointId !== input.checkpointId ||
        replay.hubEnvironmentId !== input.hubEnvironmentId
      )
        return yield* new M.MemoryHubError({ code: "identity_mismatch" });
      if (replay.expiresAt <= now) return yield* new M.MemoryHubError({ code: "cursor_expired" });
      return replay;
    }
    const tokenKey = hashText(input.snapshotToken);
    const prior = yield* stored(
      "hub-token-guard",
      sql<{
        record_json: string;
      }>`SELECT record_json FROM memory_import_keys WHERE space=${space} AND key_kind='hub_checkpoint_token' AND key=${tokenKey}`,
    );
    if (prior.length) return yield* new M.MemoryHubError({ code: "cursor_expired" });
    const guards = yield* stored(
      "hub-token-budget",
      sql<{
        rows: number;
        bytes: number;
      }>`SELECT count(*) AS rows,coalesce(sum(length(CAST(record_json AS BLOB))),0) AS bytes FROM memory_import_keys WHERE space=${space}`,
    );
    if (guards[0]!.rows >= M.MEMORY_DEDUP_MAX_RECEIPTS)
      return yield* new MemoryCapacityError({
        dimension: "dedup_receipts",
        limit: M.MEMORY_DEDUP_MAX_RECEIPTS,
      });
    const active = handles.filter(
      (h) => h.expiresAt > now && h.memberEnvironmentId !== member.environmentId,
    );
    if (active.length >= M.MEMORY_CHECKPOINT_MAX_HANDLES_PER_HUB)
      return yield* new MemoryCapacityError({
        dimension: "checkpoint_handles",
        limit: M.MEMORY_CHECKPOINT_MAX_HANDLES_PER_HUB,
      });
    const { pages, first } = yield* stageHubSnapshotTx(space, input.checkpointId, now);
    const handle: HubCheckpointHandle = {
      checkpointId: input.checkpointId,
      snapshotToken: input.snapshotToken,
      memorySpaceId: space,
      hubEnvironmentId: input.hubEnvironmentId,
      memberEnvironmentId: member.environmentId,
      credentialVersion: member.credentialVersion,
      checkpointSequence: first.checkpointSequence,
      retentionFloor: first.retentionFloor,
      firstIssuedAt: now,
      expiresAt: now + M.MEMORY_CHECKPOINT_TOKEN_TTL_MS,
      pageCount: pages.length,
    };
    const guardJson = yield* codec(CheckpointTokenGuardSchema).encode({ handle, retired: false });
    if (
      guards[0]!.bytes + new TextEncoder().encode(guardJson).length >
      M.MEMORY_PERMANENT_METADATA_MAX_BYTES
    )
      return yield* new MemoryCapacityError({
        dimension: "permanent_metadata",
        limit: M.MEMORY_PERMANENT_METADATA_MAX_BYTES,
      });
    for (const previous of handles.filter((h) => h.memberEnvironmentId === member.environmentId))
      yield* stored(
        "hub-token-retire",
        sql`UPDATE memory_import_keys SET record_json=json_set(record_json,'$.retired',json('true')) WHERE space=${space} AND key_kind='hub_checkpoint_token' AND key=${hashText(previous.snapshotToken)}`,
      );
    yield* stored(
      "hub-token-first-issue",
      sql`INSERT INTO memory_import_keys(space,key_kind,key,memory_id,record_json) VALUES (${space},'hub_checkpoint_token',${tokenKey},${space},${guardJson})`,
    );
    yield* stored(
      "hub-snapshot-pin",
      sql`UPDATE memory_hub_retention SET handles_json=${yield* handleCodec.encode([...active, handle])} WHERE space=${space}`,
    );
    return handle;
  });
  const readHubCheckpointPageTx: MemoryStore["Service"]["readHubCheckpointPageTx"] = Effect.fn(
    "MemoryStore.readHubCheckpointPageTx",
  )(function* (input) {
    const space = input.authority.principal.memorySpaceId;
    const { member, now } = yield* authorizeSource(input.authority, space);
    const handle = (yield* handlesFor(space)).find((h) => h.snapshotToken === input.snapshotToken);
    if (!handle || handle.expiresAt <= now)
      return yield* new M.MemoryHubError({ code: "cursor_expired" });
    if (
      handle.memberEnvironmentId !== member.environmentId ||
      handle.credentialVersion !== member.credentialVersion
    )
      return yield* new M.MemoryHubError({ code: "identity_mismatch" });
    const pages = yield* snapshotPages(space, handle.checkpointId);
    const ordinal =
      input.cursor === null
        ? 0
        : pages.findIndex((_, i) => cursorFor(handle.checkpointId, i) === input.cursor);
    if (ordinal < 0 || !pages[ordinal] || pages.length !== handle.pageCount)
      return yield* new M.MemoryHubError({ code: "invalid_cursor" });
    return pages[ordinal]!;
  });
  const publishCheckpointAndFloorTx: MemoryStore["Service"]["publishCheckpointAndFloorTx"] =
    Effect.fn("MemoryStore.publishCheckpointAndFloorTx")(function* (input) {
      yield* Transaction;
      yield* requireImportLineageCompleteTx(input.memorySpaceId);
      const old = yield* readHubRetentionTx(input.memorySpaceId);
      if (old.checkpointId === input.checkpointId && old.retentionFloor === input.nextFloor)
        return old;
      if (old.retentionFloor !== input.expectedFloor)
        return yield* new MemoryStoreConflict({ code: "revision_changed" });
      const pages = yield* snapshotPages(input.memorySpaceId, input.checkpointId);
      if (!M.validateMemoryCheckpointRecords(pages))
        return yield* new MemoryStoreConflict({ code: "bootstrap_required" });
      const first = pages[0]!;
      const handles = (yield* handlesFor(input.memorySpaceId)).filter(
        (h) => h.expiresAt > input.now,
      );
      if (
        input.nextFloor < old.retentionFloor ||
        input.nextFloor > first.checkpointSequence ||
        first.checkpointSequence < old.checkpointSequence ||
        handles.some((h) => h.checkpointSequence < input.nextFloor)
      )
        return yield* new MemoryStoreConflict({ code: "revision_changed" });
      // Pages are complete and durable before either recovery state or its operational floor moves.
      yield* stored(
        "hub-snapshot-publish",
        sql`UPDATE memory_hub_retention SET checkpoint_id=${input.checkpointId},checkpoint_sequence=${first.checkpointSequence},retention_floor=${input.nextFloor},boundary_json=${yield* boundaryCodec.encode(first.causalBoundary)},handles_json=${yield* handleCodec.encode(handles)} WHERE space=${input.memorySpaceId}`,
      );
      yield* stored(
        "hub-snapshot-bootstrap",
        sql`INSERT INTO memory_compaction_state(space,checkpoint_id,boundary_json,retained_revision_boundary,published) VALUES (${input.memorySpaceId},${input.checkpointId},${yield* boundaryCodec.encode(first.causalBoundary)},${input.nextFloor},1) ON CONFLICT(space) DO UPDATE SET checkpoint_id=excluded.checkpoint_id,boundary_json=excluded.boundary_json,retained_revision_boundary=excluded.retained_revision_boundary,published=1`,
      );
      const keep = new Set([input.checkpointId, ...handles.map((h) => h.checkpointId)]);
      const retired = yield* stored(
        "hub-snapshot-retired",
        sql<{
          checkpoint_id: string;
        }>`SELECT DISTINCT checkpoint_id FROM memory_inbox_pending WHERE space=${input.memorySpaceId} AND reason='hub_snapshot'`,
      );
      const before = yield* snapshotBytes(input.memorySpaceId);
      for (const row of retired)
        if (!keep.has(row.checkpoint_id.slice(4)))
          yield* stored(
            "hub-snapshot-retire",
            sql`DELETE FROM memory_inbox_pending WHERE space=${input.memorySpaceId} AND checkpoint_id=${row.checkpoint_id} AND reason='hub_snapshot'`,
          );
      yield* reserveHubCheckpointTx({
        memorySpaceId: input.memorySpaceId,
        checkpointDeltaBytes: 0,
        publishedPinnedDeltaBytes: (yield* snapshotBytes(input.memorySpaceId)) - before,
      });
      return yield* readHubRetentionTx(input.memorySpaceId);
    });
  const compactEligibleHistoryTx: MemoryStore["Service"]["compactEligibleHistoryTx"] = Effect.fn(
    "MemoryStore.compactEligibleHistoryTx",
  )(function* (input) {
    yield* Transaction;
    yield* requireImportLineageCompleteTx(input.memorySpaceId);
    yield* retireImportBatchesTx(input.memorySpaceId, input.now, input.limit);
    const retention = yield* readHubRetentionTx(input.memorySpaceId);
    if (retention.retentionFloor !== input.expectedFloor || !retention.checkpointId)
      return yield* new MemoryStoreConflict({ code: "revision_changed" });
    const pages = yield* snapshotPages(input.memorySpaceId, retention.checkpointId);
    if (!M.validateMemoryCheckpointRecords(pages))
      return yield* new MemoryStoreConflict({ code: "bootstrap_required" });
    const covered = new Set(
      pages.flatMap((p) => p.compactReceipts.map((r) => r.receipt.operationId)),
    );
    const rows = yield* stored(
      "hub-compact-tail",
      sql<{
        operation_id: string;
        bytes: number;
      }>`SELECT operation_id,length(CAST(entry_json AS BLOB)) AS bytes FROM memory_hub_operations WHERE space=${input.memorySpaceId} AND hub_sequence<=${input.expectedFloor} AND committed_at<=${input.now - M.MEMORY_LOG_RETENTION_MS} AND NOT EXISTS (SELECT 1 FROM memory_outbox o WHERE o.space=memory_hub_operations.space AND json_extract(o.metadata_json,'$.operationId')=memory_hub_operations.operation_id AND o.status IN ('pending','running','retry')) ORDER BY hub_sequence LIMIT ${Math.max(0, Math.min(input.limit, M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS))}`,
    );
    let removedRows = 0,
      reclaimedLogicalBytes = 0;
    for (const row of rows) {
      if (!covered.has(M.MemoryOperationId.make(row.operation_id))) continue;
      yield* stored(
        "hub-compact-delete",
        sql`DELETE FROM memory_hub_operations WHERE space=${input.memorySpaceId} AND operation_id=${row.operation_id}`,
      );
      removedRows++;
      reclaimedLogicalBytes += row.bytes;
    }
    const limit = Math.max(0, Math.min(input.limit, M.MEMORY_DEFERRED_SWEEP_MAX_ITEMS));
    const events = yield* stored(
      "hub-compact-events",
      sql<{
        operation_id: string;
        bytes: number;
      }>`SELECT e.operation_id,length(CAST(e.metadata_json AS BLOB))+length(CAST(e.receipt_json AS BLOB)) AS bytes FROM memory_events e JOIN memory_compact_receipts c ON c.space=e.memory_space_id AND c.operation_id=e.operation_id WHERE e.memory_space_id=${input.memorySpaceId} AND c.hub_sequence<=${input.expectedFloor} AND e.created_at<=${input.now - M.MEMORY_LOG_RETENTION_MS} AND NOT EXISTS (SELECT 1 FROM memory_outbox o WHERE o.space=e.memory_space_id AND json_extract(o.metadata_json,'$.operationId')=e.operation_id AND o.status IN ('pending','running','retry')) AND NOT EXISTS (SELECT 1 FROM memory_inbox_pending p WHERE p.space=e.memory_space_id AND p.operation_id=e.operation_id) ORDER BY e.sequence LIMIT ${Math.max(0, limit - removedRows)}`,
    );
    for (const event of events) {
      if (!covered.has(M.MemoryOperationId.make(event.operation_id))) continue;
      yield* stored(
        "hub-compact-event-delete",
        sql`DELETE FROM memory_events WHERE memory_space_id=${input.memorySpaceId} AND operation_id=${event.operation_id}`,
      );
      removedRows++;
      reclaimedLogicalBytes += event.bytes;
    }
    // Snapshot bodies survive independently. Keep canonical references while the published or a live pinned page needs them.
    const liveHandles = (yield* handlesFor(input.memorySpaceId)).filter(
      (h) => h.expiresAt > input.now,
    );
    const keep = yield* stringArrayCodec.encode([
      snapshotId(retention.checkpointId),
      ...liveHandles.map((h) => snapshotId(h.checkpointId)),
    ]);
    const revisions = yield* stored(
      "hub-compact-revisions",
      sql<{
        revision_id: string;
        operation_id: string;
        payload_ref: string;
        payload_bytes: number;
        bytes: number;
      }>`SELECT r.revision_id,r.operation_id,r.payload_ref,coalesce(length(CAST(p.body_json AS BLOB)),0) AS payload_bytes,coalesce(length(CAST(p.body_json AS BLOB)),0)+length(CAST(r.parents_json AS BLOB))+length(CAST(r.provenance_json AS BLOB))+length(CAST(r.scope_json AS BLOB)) AS bytes FROM memory_revisions r JOIN memory_compact_receipts c ON c.space=r.space AND c.operation_id=r.operation_id LEFT JOIN memory_payloads p ON p.space=r.space AND p.payload_ref=r.payload_ref WHERE r.space=${input.memorySpaceId} AND c.hub_sequence<=${input.expectedFloor} AND (p.purge_eligible_after<=${input.now} OR p.payload_ref IS NULL AND r.created_at<=${input.now - M.MEMORY_LOG_RETENTION_MS})
      AND NOT EXISTS (SELECT 1 FROM memory_items i JOIN json_each(i.heads_json) h WHERE i.space=r.space AND h.value=r.revision_id)
      AND NOT EXISTS (SELECT 1 FROM memory_conflicts f JOIN json_each(f.heads_json) h WHERE f.space=r.space AND f.status!='resolved' AND h.value=r.revision_id)
      AND NOT EXISTS (SELECT 1 FROM memory_resolutions v JOIN json_each(v.input_revision_ids_json) h WHERE v.space=r.space AND v.revert_deadline>${input.now} AND h.value=r.revision_id)
      AND NOT EXISTS (SELECT 1 FROM memory_revert_intents v WHERE v.space=r.space AND (v.restored_revision_id=r.revision_id OR v.payload_ref=r.payload_ref))
      AND NOT EXISTS (SELECT 1 FROM memory_outbox o WHERE o.space=r.space AND o.status IN ('pending','running','retry') AND (o.payload_ref=r.payload_ref OR instr(o.metadata_json,r.revision_id)>0 OR instr(coalesce(o.ticket_json,''),r.revision_id)>0 OR instr(coalesce(o.frozen_claim_json,''),r.revision_id)>0))
      AND NOT EXISTS (SELECT 1 FROM memory_inbox_pending b WHERE b.space=r.space AND (b.payload_ref=r.payload_ref OR b.reason='hub_snapshot' AND b.checkpoint_id IN (SELECT value FROM json_each(${keep})) AND EXISTS (SELECT 1 FROM json_each(b.metadata_json,'$.revisions') j WHERE json_extract(j.value,'$.revision.revisionId')=r.revision_id AND json_type(j.value,'$.payload')!='null')))
      AND (p.payload_ref IS NOT NULL OR (NOT EXISTS (SELECT 1 FROM memory_payloads d, json_each(d.dependencies_json) dep WHERE d.space=r.space AND dep.value=r.revision_id)
        AND NOT EXISTS (SELECT 1 FROM memory_outbox o,json_each(o.metadata_json,'$.revisions') dep WHERE o.space='_worker' AND json_extract(o.metadata_json,'$.kind')='threadLineage' AND json_extract(o.metadata_json,'$.memorySpaceId')=r.space AND dep.value=r.revision_id)))
      ORDER BY coalesce(p.purge_eligible_after,r.created_at),r.revision_id LIMIT ${Math.max(0, limit - removedRows)}`,
    );
    for (const revision of revisions) {
      if (!covered.has(M.MemoryOperationId.make(revision.operation_id))) continue;
      const deleted = yield* stored(
        "hub-compact-payload-delete",
        sql<{
          bytes: number;
        }>`DELETE FROM memory_payloads WHERE space=${input.memorySpaceId} AND payload_ref=${revision.payload_ref}
        AND NOT EXISTS (SELECT 1 FROM memory_revisions v WHERE v.space=${input.memorySpaceId} AND v.payload_ref=${revision.payload_ref} AND v.revision_id!=${revision.revision_id}) RETURNING length(CAST(body_json AS BLOB)) AS bytes`,
      );
      // Keep only canonical identity metadata while a live payload needs the
      // revision->memory edge for forget's reverse closure. Its body was deleted above.
      const retained = yield* stored(
        "hub-compact-lineage-reference",
        sql`SELECT 1 FROM memory_payloads p, json_each(p.dependencies_json) d WHERE p.space=${input.memorySpaceId} AND d.value=${revision.revision_id}
          UNION ALL SELECT 1 FROM memory_outbox o,json_each(o.metadata_json,'$.revisions') d WHERE o.space='_worker' AND json_extract(o.metadata_json,'$.kind')='threadLineage' AND json_extract(o.metadata_json,'$.memorySpaceId')=${input.memorySpaceId} AND d.value=${revision.revision_id} LIMIT 1`,
      );
      if (retained.length) {
        removedRows++;
        reclaimedLogicalBytes += revision.payload_bytes;
        continue;
      }
      yield* stored(
        "hub-compact-revision-delete",
        sql`DELETE FROM memory_revisions WHERE space=${input.memorySpaceId} AND revision_id=${revision.revision_id}`,
      );
      removedRows++;
      reclaimedLogicalBytes += revision.bytes - revision.payload_bytes + (deleted[0]?.bytes ?? 0);
    }
    const judgments = yield* stored(
      "hub-compact-judgments",
      sql<{
        resolution_id: string;
        operation_id: string;
        judgment_payload_ref: string;
        bytes: number;
      }>`SELECT r.resolution_id,c.operation_id,r.judgment_payload_ref,length(CAST(p.body_json AS BLOB)) AS bytes FROM memory_resolutions r JOIN memory_payloads p ON p.space=r.space AND p.payload_ref=r.judgment_payload_ref JOIN memory_compact_receipts c ON c.space=r.space AND json_extract(c.compact_json,'$.operationKind')='resolve' AND json_extract(c.compact_json,'$.resolutionId')=r.resolution_id AND json_extract(c.compact_json,'$.revisionId')=r.result_revision_id AND json_extract(c.compact_json,'$.receipt.memoryId')=r.memory_id AND json_extract(c.receipt_json,'$.outcome')='accepted' LEFT JOIN memory_revisions v ON v.space=r.space AND v.revision_id=r.result_revision_id WHERE r.space=${input.memorySpaceId} AND r.revert_deadline<=${input.now} AND c.hub_sequence<=${input.expectedFloor}
      AND NOT EXISTS (SELECT 1 FROM memory_revert_intents i WHERE i.space=r.space AND i.resolution_id=r.resolution_id)
      AND NOT EXISTS (SELECT 1 FROM memory_outbox o WHERE o.space=r.space AND o.status IN ('pending','running','retry') AND (o.payload_ref=r.judgment_payload_ref OR o.payload_ref=v.payload_ref OR instr(o.metadata_json,r.resolution_id)>0 OR instr(o.metadata_json,r.result_revision_id)>0 OR instr(coalesce(o.ticket_json,''),r.resolution_id)>0 OR instr(coalesce(o.ticket_json,''),r.result_revision_id)>0 OR instr(coalesce(o.frozen_claim_json,''),r.resolution_id)>0 OR instr(coalesce(o.frozen_claim_json,''),r.result_revision_id)>0))
      AND NOT EXISTS (SELECT 1 FROM memory_inbox_pending b JOIN json_each(b.metadata_json,'$.resolutions') j WHERE b.space=r.space AND b.reason='hub_snapshot' AND b.checkpoint_id IN (SELECT value FROM json_each(${keep})) AND json_extract(j.value,'$.resolution.resolutionId')=r.resolution_id)
      ORDER BY r.revert_deadline,r.resolution_id LIMIT ${Math.max(0, limit - removedRows)}`,
    );
    for (const judgment of judgments) {
      if (!covered.has(M.MemoryOperationId.make(judgment.operation_id))) continue;
      yield* stored(
        "hub-compact-judgment-delete",
        sql`DELETE FROM memory_payloads WHERE space=${input.memorySpaceId} AND payload_ref=${judgment.judgment_payload_ref}`,
      );
      removedRows++;
      reclaimedLogicalBytes += judgment.bytes;
    }
    const terminalWork = yield* stored(
      "hub-compact-terminal-work",
      sql<{
        id: string;
        bytes: number;
      }>`SELECT id,length(CAST(metadata_json AS BLOB))+coalesce(length(CAST(ticket_json AS BLOB)),0)+coalesce(length(CAST(frozen_claim_json AS BLOB)),0) AS bytes FROM memory_outbox o WHERE space=${input.memorySpaceId} AND kind IN ('sync','resolve','revert_intent','rebuild') AND status IN ('completed','failed','cancelled') AND terminal_at<=${input.now - M.MEMORY_LOG_RETENTION_MS} AND NOT EXISTS(SELECT 1 FROM memory_pending_forget_intents f WHERE f.space=o.space AND f.operation_id=json_extract(o.metadata_json,'$.operationId')) ORDER BY terminal_at,id LIMIT ${Math.max(0, limit - removedRows)}`,
    );
    for (const work of terminalWork) {
      yield* stored(
        "hub-compact-terminal-work-delete",
        sql`DELETE FROM memory_outbox WHERE id=${work.id}`,
      );
      removedRows++;
      reclaimedLogicalBytes += work.bytes;
    }
    const purgedReports = yield* purgeDeliveredReportDetailsTx({
      memorySpaceId: input.memorySpaceId,
      now: input.now,
      limit: Math.max(0, limit - removedRows),
    });
    removedRows += purgedReports.removedRows;
    reclaimedLogicalBytes += purgedReports.reclaimedLogicalBytes;
    const status: M.MemoryCompactionStatus = {
      lastRunAtUtc: M.MemoryUtcTimestamp.make(DateTime.formatIso(DateTime.makeUnsafe(input.now))),
      removedRows,
      reclaimedLogicalBytes,
      reclaimableLogicalBytes: 0,
      blockedReasons: [],
    };
    yield* stored(
      "hub-compact-status",
      sql`UPDATE memory_hub_retention SET compaction_json=${yield* compactionCodec.encode(status)} WHERE space=${input.memorySpaceId}`,
    );
    return status;
  });
  const readHubUsageTx: MemoryStore["Service"]["readHubUsageTx"] = Effect.fn(
    "MemoryStore.readHubUsageTx",
  )(function* (space) {
    yield* Transaction;
    yield* stored(
      "checkpoint-accounting",
      refreshCheckpointAccounting().pipe(Effect.provideService(SqlClient.SqlClient, sql)),
    );
    const rows = yield* stored(
      "hub-usage",
      sql<{
        tail_rows: number;
        tail_bytes: number;
        members: number;
        relay: number;
        source_bytes: number;
        checkpoint_bytes: number;
        last_snapshot_bytes: number;
        consumed_bytes: number;
        pinned_bytes: number;
        metadata_bytes: number;
      }>`SELECT
      (SELECT count(*) FROM memory_hub_operations WHERE space=${space}) AS tail_rows,
      (SELECT coalesce(sum(length(CAST(entry_json AS BLOB))),0) FROM memory_hub_operations WHERE space=${space}) AS tail_bytes,
      (SELECT count(*) FROM memory_hub_members WHERE space=${space} AND status='active') AS members,
      (SELECT count(*) FROM memory_hub_source_reads WHERE space=${space} AND state!='expired') AS relay,
      (SELECT coalesce(sum(length(CAST(p.body_json AS BLOB))),0) FROM memory_payloads p JOIN memory_hub_source_reads r ON r.space=p.space AND r.payload_ref=p.payload_ref WHERE r.space=${space}) AS source_bytes,
      (SELECT coalesce(checkpoint_bytes,0) FROM memory_hub_retention WHERE space=${space}) AS checkpoint_bytes,
      (SELECT coalesce(last_snapshot_bytes,0) FROM memory_hub_retention WHERE space=${space}) AS last_snapshot_bytes,
      (SELECT CASE WHEN r.checkpoint_id IS NOT r.reserved_snapshot_id AND NOT EXISTS(SELECT 1 FROM json_each(r.handles_json) h WHERE json_extract(h.value,'$.checkpointId')=r.reserved_snapshot_id) AND r.snapshot_generation=coalesce((SELECT value FROM memory_quota_counters WHERE space=r.space AND dimension='hub_snapshot_generation' AND scope_key=''),0) AND EXISTS(SELECT 1 FROM memory_inbox_pending p WHERE p.space=r.space AND p.reason='hub_snapshot' AND p.checkpoint_id='hub:'||r.reserved_snapshot_id) THEN min(r.last_snapshot_bytes,r.published_pinned_bytes) ELSE 0 END FROM memory_hub_retention r WHERE r.space=${space}) AS consumed_bytes,
      (SELECT coalesce(published_pinned_bytes,0) FROM memory_hub_retention WHERE space=${space}) AS pinned_bytes,
      (SELECT coalesce(sum(length(CAST(credential_digest AS BLOB))+length(CAST(environment AS BLOB))+32),0) FROM memory_hub_members WHERE space=${space})+
      (SELECT coalesce(sum(length(CAST(lease_json AS BLOB))+32),0) FROM memory_hub_leases WHERE space=${space}) AS metadata_bytes`,
    );
    const row = rows[0]!;
    const inputs = yield* stored(
      "hub-snapshot-input-counters",
      sql<{
        dimension: string;
        value: number;
      }>`SELECT dimension,value FROM memory_quota_counters WHERE space=${space} AND scope_key='' AND dimension IN ('hub_snapshot_bytes','hub_snapshot_rows')`,
    );
    const inputCounters = new Map(inputs.map((r) => [r.dimension, r.value]));
    const requiredCheckpointBoundBytes = checkpointBound(
      inputCounters.get("hub_snapshot_bytes") ?? 0,
      inputCounters.get("hub_snapshot_rows") ?? 0,
    );
    const usage = yield* usageForHub(space);
    const specifications = [
      ["memory_import_lineage", "length(CAST(record_json AS BLOB))"],
      ["memory_hub_operations", "length(CAST(entry_json AS BLOB))"],
      [
        "memory_hub_members",
        "length(CAST(space AS BLOB))+length(CAST(environment AS BLOB))+length(CAST(credential_digest AS BLOB))+length(CAST(credential_version AS TEXT))+length(CAST(status AS BLOB))+coalesce(length(CAST(joined_at AS TEXT)),0)",
      ],
      [
        "memory_hub_leases",
        "length(CAST(space AS BLOB))+length(CAST(memory_id AS BLOB))+length(CAST(highest_token AS TEXT))+coalesce(length(CAST(lease_json AS BLOB)),0)",
      ],
      [
        "memory_hub_source_reads",
        "length(CAST(locator_json AS BLOB))+length(CAST(request_digest AS BLOB))+coalesce(length(CAST(response_digest AS BLOB)),0)",
      ],
      [
        "memory_hub_retention",
        "coalesce(length(CAST(boundary_json AS BLOB)),0)+length(CAST(handles_json AS BLOB))+coalesce(length(CAST(compaction_json AS BLOB)),0)",
      ],
    ] as const;
    const tables: M.MemoryStorageTableUsage[] = [];
    for (const [table, expression] of specifications) {
      // Both identifiers and expressions come only from the closed internal inventory above.
      const counts = yield* stored(
        "hub-table-logical",
        sql.unsafe<{ rows: number; bytes: number }>(
          `SELECT count(*) AS rows,coalesce(sum(${expression}),0) AS bytes FROM ${table} WHERE space=?`,
          [space],
        ),
      );
      tables.push({
        table,
        rowCount: counts[0]!.rows,
        logicalBytes: counts[0]!.bytes,
        allocatedBytes: null,
        allocationStatus: "unavailable",
      });
    }
    tables.push({
      table: "memory_report_outbox",
      rowCount: usage.reportRows,
      logicalBytes: usage.reportMetadataBytes,
      allocatedBytes: null,
      allocationStatus: "unavailable",
    });
    return {
      tables,
      tailRows: row.tail_rows,
      tailBytes: row.tail_bytes,
      permanentMetadataBytes: tables
        .filter(
          (table) =>
            table.table === "memory_report_outbox" ||
            table.table === "memory_import_lineage" ||
            table.table === "memory_hub_members" ||
            table.table === "memory_hub_leases" ||
            table.table === "memory_hub_retention",
        )
        .reduce((sum, table) => sum + table.logicalBytes, 0),
      activeMembers: row.members,
      stagingBytes:
        Math.max(requiredCheckpointBoundBytes, row.checkpoint_bytes ?? 0) +
        (row.pinned_bytes ?? 0) -
        (row.consumed_bytes ?? 0),
      requiredCheckpointBoundBytes,
      lastSnapshotBytes: row.last_snapshot_bytes ?? 0,
      checkpointReservationConsumedBytes: row.consumed_bytes ?? 0,
      checkpointBytes: row.checkpoint_bytes ?? 0,
      publishedPinnedBytes: row.pinned_bytes ?? 0,
      liveSourceReads: row.relay,
      sourcePayloadBytes: row.source_bytes,
      ...usage,
    };
  });
  const readHubInventoryTx = Effect.fn("MemoryStore.readHubInventoryTx")(function* (
    space: M.MemorySpaceId,
  ) {
    yield* Transaction;
    const now = yield* Clock.currentTimeMillis;
    const inventory = yield* stored(
      "hub-reserved-reclaimable",
      sql<{
        forget_bytes: number;
        forget_receipts: number;
        forget_keys: number;
        terminal_work_rows: number;
        terminal_work_bytes: number;
        source_bytes: number;
        snapshot_bytes: number;
        tail_rows: number;
        tail_bytes: number;
        history_bytes: number;
        expired_relays: number;
        expired_handles: number;
        admin_rows: number;
      }>`SELECT
      (SELECT count(*) FROM memory_outbox WHERE kind='admin') AS admin_rows,
      (SELECT count(*) FROM memory_hub_source_reads WHERE space=${space} AND state!='expired' AND deadline<=${now}) AS expired_relays,
      (SELECT count(*) FROM memory_hub_retention r,json_each(r.handles_json) h WHERE r.space=${space} AND json_extract(h.value,'$.expiresAt')<=${now}) AS expired_handles,
      (SELECT coalesce(sum(max(0,reserve_bytes-${M.MEMORY_IDENTITY_CORE_MAX_BYTES})),0) FROM memory_identity_ledger i WHERE i.space=${space} AND NOT EXISTS(SELECT 1 FROM memory_tombstones t WHERE t.space=i.space AND t.memory_id=i.memory_id)) AS forget_bytes,
      (SELECT count(*) FROM memory_identity_ledger i WHERE i.space=${space} AND NOT EXISTS(SELECT 1 FROM memory_tombstones t WHERE t.space=i.space AND t.memory_id=i.memory_id)) AS forget_receipts,
      (SELECT coalesce(sum(reserve_keys),0) FROM memory_identity_ledger i WHERE i.space=${space} AND NOT EXISTS(SELECT 1 FROM memory_tombstones t WHERE t.space=i.space AND t.memory_id=i.memory_id)) AS forget_keys,
      (SELECT count(*) FROM memory_outbox o WHERE o.space=${space} AND kind IN ('sync','resolve','revert_intent','rebuild') AND status IN ('completed','failed','cancelled') AND terminal_at<=${now - M.MEMORY_LOG_RETENTION_MS} AND NOT EXISTS(SELECT 1 FROM memory_pending_forget_intents f WHERE f.space=o.space AND f.operation_id=json_extract(o.metadata_json,'$.operationId'))) AS terminal_work_rows,
      (SELECT coalesce(sum(length(CAST(metadata_json AS BLOB))+coalesce(length(CAST(ticket_json AS BLOB)),0)+coalesce(length(CAST(frozen_claim_json AS BLOB)),0)),0) FROM memory_outbox o WHERE o.space=${space} AND kind IN ('sync','resolve','revert_intent','rebuild') AND status IN ('completed','failed','cancelled') AND terminal_at<=${now - M.MEMORY_LOG_RETENTION_MS} AND NOT EXISTS(SELECT 1 FROM memory_pending_forget_intents f WHERE f.space=o.space AND f.operation_id=json_extract(o.metadata_json,'$.operationId'))) AS terminal_work_bytes,

      (SELECT coalesce(sum(length(CAST(p.body_json AS BLOB))),0) FROM memory_payloads p JOIN memory_hub_source_reads r ON r.space=p.space AND r.payload_ref=p.payload_ref WHERE r.space=${space} AND r.deadline<=${now}) AS source_bytes,
      (SELECT coalesce(sum(length(CAST(b.metadata_json AS BLOB))),0) FROM memory_inbox_pending b WHERE b.space=${space} AND b.reason='hub_snapshot' AND b.checkpoint_id!=coalesce((SELECT 'hub:'||checkpoint_id FROM memory_hub_retention WHERE space=${space}),'') AND NOT EXISTS(SELECT 1 FROM memory_hub_retention r,json_each(r.handles_json) h WHERE r.space=b.space AND 'hub:'||json_extract(h.value,'$.checkpointId')=b.checkpoint_id AND json_extract(h.value,'$.expiresAt')>${now})) AS snapshot_bytes,
      (SELECT count(*) FROM memory_hub_operations o JOIN memory_hub_retention r ON r.space=o.space WHERE o.space=${space} AND o.hub_sequence<=r.retention_floor AND o.committed_at<=${now - M.MEMORY_LOG_RETENTION_MS} AND EXISTS(SELECT 1 FROM memory_inbox_pending b,json_each(b.metadata_json,'$.compactReceipts') j WHERE b.space=o.space AND b.checkpoint_id='hub:'||r.checkpoint_id AND json_extract(j.value,'$.receipt.operationId')=o.operation_id) AND NOT EXISTS(SELECT 1 FROM memory_outbox w WHERE w.space=o.space AND json_extract(w.metadata_json,'$.operationId')=o.operation_id AND w.status IN ('pending','running','retry'))) AS tail_rows,
      (SELECT coalesce(sum(length(CAST(o.entry_json AS BLOB))),0) FROM memory_hub_operations o JOIN memory_hub_retention r ON r.space=o.space WHERE o.space=${space} AND o.hub_sequence<=r.retention_floor AND o.committed_at<=${now - M.MEMORY_LOG_RETENTION_MS} AND EXISTS(SELECT 1 FROM memory_inbox_pending b,json_each(b.metadata_json,'$.compactReceipts') j WHERE b.space=o.space AND b.checkpoint_id='hub:'||r.checkpoint_id AND json_extract(j.value,'$.receipt.operationId')=o.operation_id) AND NOT EXISTS(SELECT 1 FROM memory_outbox w WHERE w.space=o.space AND json_extract(w.metadata_json,'$.operationId')=o.operation_id AND w.status IN ('pending','running','retry'))) AS tail_bytes,
      (SELECT coalesce(sum(length(CAST(p.body_json AS BLOB))),0) FROM memory_payloads p JOIN memory_revisions v ON v.space=p.space AND v.payload_ref=p.payload_ref JOIN memory_compact_receipts c ON c.space=v.space AND c.operation_id=v.operation_id JOIN memory_hub_retention r ON r.space=v.space WHERE p.space=${space} AND p.purge_eligible_after<=${now} AND c.hub_sequence<=r.retention_floor
        AND EXISTS(SELECT 1 FROM memory_inbox_pending b,json_each(b.metadata_json,'$.compactReceipts') j WHERE b.space=v.space AND b.checkpoint_id='hub:'||r.checkpoint_id AND json_extract(j.value,'$.receipt.operationId')=v.operation_id)
        AND NOT EXISTS(SELECT 1 FROM memory_items i,json_each(i.heads_json) h WHERE i.space=v.space AND h.value=v.revision_id)
        AND NOT EXISTS(SELECT 1 FROM memory_conflicts f,json_each(f.heads_json) h WHERE f.space=v.space AND f.status!='resolved' AND h.value=v.revision_id)
        AND NOT EXISTS(SELECT 1 FROM memory_resolutions x,json_each(x.input_revision_ids_json) h WHERE x.space=v.space AND x.revert_deadline>${now} AND h.value=v.revision_id)
        AND NOT EXISTS(SELECT 1 FROM memory_revert_intents x WHERE x.space=v.space AND (x.restored_revision_id=v.revision_id OR x.payload_ref=v.payload_ref))
        AND NOT EXISTS(SELECT 1 FROM memory_outbox w WHERE w.space=v.space AND w.status IN ('pending','running','retry') AND (w.payload_ref=v.payload_ref OR instr(w.metadata_json,v.revision_id)>0 OR instr(coalesce(w.ticket_json,''),v.revision_id)>0 OR instr(coalesce(w.frozen_claim_json,''),v.revision_id)>0))
        AND NOT EXISTS(SELECT 1 FROM memory_inbox_pending b WHERE b.space=v.space AND (b.payload_ref=v.payload_ref OR b.reason='hub_snapshot' AND EXISTS(SELECT 1 FROM json_each(b.metadata_json,'$.revisions') j WHERE json_extract(j.value,'$.revision.revisionId')=v.revision_id AND json_type(j.value,'$.payload')!='null') AND (b.checkpoint_id='hub:'||r.checkpoint_id OR EXISTS(SELECT 1 FROM json_each(r.handles_json) h WHERE 'hub:'||json_extract(h.value,'$.checkpointId')=b.checkpoint_id AND json_extract(h.value,'$.expiresAt')>${now}))))) AS history_bytes`,
    );
    const inventoryRow = inventory[0]!;
    const adminRows = yield* stored(
      "hub-admin-reclaimable",
      sql<{
        admin_json: string;
      }>`SELECT admin_json FROM memory_outbox WHERE kind='admin' AND status='completed' AND terminal_at<=${now - M.MEMORY_LOG_RETENTION_MS} AND json_extract(admin_json,'$.stage')='acknowledged'`,
    );
    let adminBytes = 0;
    for (const row of adminRows) {
      const originalBytes = new TextEncoder().encode(row.admin_json).length;
      const guardBytes = new TextEncoder().encode(
        yield* adminReplayJson(yield* adminCodec.decode(row.admin_json, strict)),
      ).length;
      adminBytes += Math.max(0, originalBytes - guardBytes);
    }
    const details = yield* stored(
      "hub-reclaimable-details",
      sql<{ report_bytes: number; event_bytes: number; judgment_bytes: number }>`SELECT
      (SELECT coalesce(sum(${sql.unsafe(reportMetadataBytes("x."))}),0) FROM memory_report_outbox x WHERE space=${space} AND state='delivered' AND delivered_at<=${now - M.MEMORY_REPORT_DETAIL_RETENTION_MS} AND EXISTS(SELECT 1 FROM memory_import_keys g WHERE g.space=x.space AND g.key_kind='report_delivered' AND g.key=x.report_id)) AS report_bytes,
      (SELECT coalesce(sum(length(CAST(e.metadata_json AS BLOB))+length(CAST(e.receipt_json AS BLOB))),0) FROM memory_events e JOIN memory_compact_receipts c ON c.space=e.memory_space_id AND c.operation_id=e.operation_id JOIN memory_hub_retention r ON r.space=c.space WHERE e.memory_space_id=${space} AND c.hub_sequence<=r.retention_floor AND e.created_at<=${now - M.MEMORY_LOG_RETENTION_MS}
        AND EXISTS(SELECT 1 FROM memory_inbox_pending b,json_each(b.metadata_json,'$.compactReceipts') j WHERE b.space=c.space AND b.checkpoint_id='hub:'||r.checkpoint_id AND json_extract(j.value,'$.receipt.operationId')=e.operation_id)
        AND NOT EXISTS(SELECT 1 FROM memory_outbox w WHERE w.space=c.space AND json_extract(w.metadata_json,'$.operationId')=e.operation_id AND w.status IN ('pending','running','retry'))
        AND NOT EXISTS(SELECT 1 FROM memory_inbox_pending b WHERE b.space=c.space AND b.operation_id=e.operation_id)) AS event_bytes,
      (SELECT coalesce(sum(length(CAST(p.body_json AS BLOB))),0) FROM memory_resolutions x JOIN memory_payloads p ON p.space=x.space AND p.payload_ref=x.judgment_payload_ref JOIN memory_compact_receipts c ON c.space=x.space AND json_extract(c.compact_json,'$.operationKind')='resolve' AND json_extract(c.compact_json,'$.resolutionId')=x.resolution_id AND json_extract(c.compact_json,'$.revisionId')=x.result_revision_id AND json_extract(c.compact_json,'$.receipt.memoryId')=x.memory_id AND json_extract(c.receipt_json,'$.outcome')='accepted' LEFT JOIN memory_revisions v ON v.space=x.space AND v.revision_id=x.result_revision_id JOIN memory_hub_retention r ON r.space=x.space WHERE x.space=${space} AND x.revert_deadline<=${now} AND c.hub_sequence<=r.retention_floor
        AND EXISTS(SELECT 1 FROM memory_inbox_pending b,json_each(b.metadata_json,'$.compactReceipts') j WHERE b.space=c.space AND b.checkpoint_id='hub:'||r.checkpoint_id AND json_extract(j.value,'$.receipt.operationId')=c.operation_id)
        AND NOT EXISTS(SELECT 1 FROM memory_revert_intents i WHERE i.space=x.space AND i.resolution_id=x.resolution_id)
        AND NOT EXISTS(SELECT 1 FROM memory_outbox w WHERE w.space=x.space AND w.status IN ('pending','running','retry') AND (w.payload_ref=x.judgment_payload_ref OR w.payload_ref=v.payload_ref OR instr(w.metadata_json,x.resolution_id)>0 OR instr(w.metadata_json,x.result_revision_id)>0 OR instr(coalesce(w.ticket_json,''),x.resolution_id)>0 OR instr(coalesce(w.ticket_json,''),x.result_revision_id)>0 OR instr(coalesce(w.frozen_claim_json,''),x.resolution_id)>0 OR instr(coalesce(w.frozen_claim_json,''),x.result_revision_id)>0))
        AND NOT EXISTS(SELECT 1 FROM memory_inbox_pending b,json_each(b.metadata_json,'$.resolutions') j WHERE b.space=x.space AND b.reason='hub_snapshot' AND json_extract(j.value,'$.resolution.resolutionId')=x.resolution_id AND (b.checkpoint_id='hub:'||r.checkpoint_id OR EXISTS(SELECT 1 FROM json_each(r.handles_json) h WHERE 'hub:'||json_extract(h.value,'$.checkpointId')=b.checkpoint_id AND json_extract(h.value,'$.expiresAt')>${now})))) AS judgment_bytes`,
    );

    return {
      reserved: {
        checkpoint_staging: (yield* readHubUsageTx(space)).requiredCheckpointBoundBytes,
        permanent_metadata:
          inventoryRow.forget_bytes +
          inventoryRow.forget_receipts * M.MEMORY_COMPACT_RECEIPT_MAX_BYTES,
        receipts: inventoryRow.forget_receipts + inventoryRow.admin_rows,
        import_source_items: inventoryRow.forget_keys + inventoryRow.admin_rows,
      },
      reclaimable: {
        checkpoint_staging: inventoryRow.snapshot_bytes,
        relay_hub: inventoryRow.expired_relays,
        checkpoint_handles: inventoryRow.expired_handles,
        log_tail_rows: inventoryRow.tail_rows,
        log_tail_bytes: inventoryRow.tail_bytes + details[0]!.event_bytes,
        history: inventoryRow.history_bytes + details[0]!.judgment_bytes,
        permanent_metadata: adminBytes + details[0]!.report_bytes,
        work_items: inventoryRow.terminal_work_rows,
        work_bytes: inventoryRow.terminal_work_bytes + adminBytes + inventoryRow.source_bytes,
      },
    };
  });
  // Handles are counted from the bounded retention record, never by a physical page scan.
  const usageForHub = Effect.fnUntraced(function* (space: M.MemorySpaceId) {
    const rows = yield* stored(
      "hub-handles",
      sql<{
        count: number;
      }>`SELECT coalesce(json_array_length(handles_json),0) AS count FROM memory_hub_retention WHERE space=${space}`,
    );
    const reports = yield* stored(
      "hub-report-counters",
      sql<{
        dimension: string;
        value: number;
      }>`SELECT dimension,value FROM memory_quota_counters WHERE space=${space} AND scope_key='' AND dimension IN ('report_all_rows','report_all_bytes','report_items','report_bytes')`,
    );
    const counters = new Map(reports.map((r) => [r.dimension, r.value]));
    return {
      liveHandles: rows[0]?.count ?? 0,
      reportItems: counters.get("report_items") ?? 0,
      reportBytes: counters.get("report_bytes") ?? 0,
      reportRows: counters.get("report_all_rows") ?? 0,
      reportMetadataBytes: counters.get("report_all_bytes") ?? 0,
    };
  });
  const reserveHubCheckpointTx: MemoryStore["Service"]["reserveHubCheckpointTx"] = Effect.fn(
    "MemoryStore.reserveHubCheckpointTx",
  )(function* (input) {
    yield* Transaction;
    yield* stored(
      "hub-reserve-init",
      sql`INSERT INTO memory_hub_retention(space) VALUES (${input.memorySpaceId}) ON CONFLICT(space) DO NOTHING`,
    );
    const rows = yield* stored(
      "hub-reserve",
      sql`UPDATE memory_hub_retention SET checkpoint_bytes=checkpoint_bytes+${input.checkpointDeltaBytes},published_pinned_bytes=published_pinned_bytes+${input.publishedPinnedDeltaBytes} WHERE space=${input.memorySpaceId}
      AND checkpoint_bytes+${input.checkpointDeltaBytes}>=0 AND published_pinned_bytes+${input.publishedPinnedDeltaBytes}>=0
      RETURNING space`,
    );
    if (!rows.length)
      return yield* new MemoryCapacityError({
        dimension: "checkpoint_staging",
        limit: M.MEMORY_CHECKPOINT_STAGING_MAX_BYTES,
      });
    return yield* readHubUsageTx(input.memorySpaceId);
  });
  const appendHubEntryTx: MemoryStore["Service"]["appendHubEntryTx"] = Effect.fn(
    "MemoryStore.appendHubEntryTx",
  )(function* (input) {
    yield* Transaction;
    const op = yield* stored("hub-operation", decodeOperation(input.operation, strict));
    if (hashText(M.encodeMemoryOperation(op)) !== input.operationDigest)
      return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
    const old = yield* readHubReceiptTx(op.memorySpaceId, op.operationId);
    if (old) {
      if (old.entry.receipt.operationDigest !== input.operationDigest)
        return yield* new MemoryStoreConflict({ code: "operation_id_reused" });
      return old;
    }
    const aggregate = yield* loadAggregate(op.memorySpaceId, op.memoryId, {}, {});
    const reservedDelete =
      op.kind === "forget" &&
      aggregate.identity !== undefined &&
      (!aggregate.tombstone || aggregate.tombstone.deleteOperationId === op.operationId);
    const counts = yield* readHubUsageTx(op.memorySpaceId);
    if (!reservedDelete && counts.tailRows >= M.MEMORY_LOG_MAX_TAIL_ROWS)
      return yield* new MemoryCapacityError({
        dimension: "log_tail_rows",
        limit: M.MEMORY_LOG_MAX_TAIL_ROWS,
      });
    const inserted = yield* stored(
      "hub-append",
      sql<{
        hub_sequence: number;
      }>`INSERT INTO memory_hub_operations(space,operation_id,memory_id,origin_environment,operation_digest,entry_json,committed_at) VALUES (${op.memorySpaceId},${op.operationId},${op.memoryId},${op.originEnvironmentId},${input.operationDigest},'{}',${input.now}) RETURNING hub_sequence`,
    );
    const hubSequence = inserted[0]!.hub_sequence;
    const receipt = yield* stored(
      "hub-receipt-codec",
      hubReceiptDecode(
        {
          operationId: op.operationId,
          memoryId: op.memoryId,
          operationDigest: input.operationDigest,
          outcome: input.outcome,
          hubSequence,
          ...(input.failureCode ? { failureCode: input.failureCode } : {}),
          ...(input.capacity ? { capacity: input.capacity } : {}),
          ...(input.resolutionApproval ? { resolutionApproval: input.resolutionApproval } : {}),
        },
        strict,
      ),
    );
    const entry: M.MemoryHubEntry =
      input.outcome === "rejected"
        ? {
            kind: "metadata",
            operationKind: op.kind,
            hubSequence,
            receipt,
            memoryId: op.memoryId,
            ...(op.kind === "resolve" ? { resolutionId: op.resolution.resolutionId } : {}),
          }
        : { kind: "operation", hubSequence, receipt, operation: op };
    const json = yield* stored("hub-entry-codec", hubEntryCodec.encode(entry));
    if (
      !reservedDelete &&
      counts.tailBytes + new TextEncoder().encode(json).length > M.MEMORY_LOG_MAX_TAIL_BYTES
    )
      return yield* new MemoryCapacityError({
        dimension: "log_tail_bytes",
        limit: M.MEMORY_LOG_MAX_TAIL_BYTES,
      });
    yield* stored(
      "hub-append-finalize",
      sql`UPDATE memory_hub_operations SET entry_json=${json},payload_ref=${op.kind === "forget" ? null : op.revision.payloadRef} WHERE hub_sequence=${hubSequence}`,
    );
    const record: M.MemoryCompactReceipt = {
      memorySpaceId: op.memorySpaceId,
      originEnvironmentId: op.originEnvironmentId,
      operationKind: op.kind,
      ...(op.kind === "upsert" && op.revision.provenance.upsertRequestDigest !== undefined
        ? { upsertRequestDigest: op.revision.provenance.upsertRequestDigest }
        : {}),
      receipt,
      revisionId:
        op.kind === "forget" || input.outcome === "rejected" ? null : op.revision.revisionId,
      resolutionId:
        op.kind === "resolve"
          ? op.resolution.resolutionId
          : op.kind === "revert"
            ? op.revertsResolutionId
            : null,
      revertsResolutionId: op.kind === "revert" ? op.revertsResolutionId : null,
      attemptId:
        op.kind === "resolve" ? (aggregate.fence?.activeLease?.attemptId ?? op.operationId) : null,
      fencingToken: op.kind === "resolve" ? op.fencingToken : null,
      reportGuard:
        (op.kind === "resolve" || op.kind === "revert") &&
        (input.outcome === "accepted" || input.outcome === "conflicted")
          ? {
              reportId: resolutionReportId(
                op.memorySpaceId,
                op.operationId,
                op.kind === "resolve" ? op.resolution.resolutionId : op.revertsResolutionId,
              ),
              resolvingEnvironmentId: op.originEnvironmentId,
              resolutionId:
                op.kind === "resolve" ? op.resolution.resolutionId : op.revertsResolutionId,
              outcome: op.kind === "resolve" ? "resolved" : "reverted",
            }
          : null,
    };
    yield* persistCompactReceipt(record);
    const finalEntry = entry.kind === "metadata" ? { ...entry, compactReceipt: record } : entry;
    const finalJson = yield* hubEntryCodec.encode(finalEntry);
    if (
      !reservedDelete &&
      counts.tailBytes + new TextEncoder().encode(finalJson).length > M.MEMORY_LOG_MAX_TAIL_BYTES
    )
      return yield* new MemoryCapacityError({
        dimension: "log_tail_bytes",
        limit: M.MEMORY_LOG_MAX_TAIL_BYTES,
      });
    yield* stored(
      "hub-append-guard",
      sql`UPDATE memory_hub_operations SET entry_json=${finalJson} WHERE hub_sequence=${hubSequence}`,
    );
    return { entry: finalEntry, committedAt: input.now };
  });
  const readHubTailTx: MemoryStore["Service"]["readHubTailTx"] = Effect.fn(
    "MemoryStore.readHubTailTx",
  )(function* (input) {
    yield* Transaction;
    const retention = yield* readHubRetentionTx(input.memorySpaceId);
    if (input.afterSequence < retention.retentionFloor)
      return yield* new M.MemoryHubError({ code: "cursor_expired" });
    const max = yield* stored(
      "hub-watermark",
      sql<{
        sequence: number;
      }>`SELECT coalesce(max(hub_sequence),0) AS sequence FROM memory_hub_operations WHERE space=${input.memorySpaceId}`,
    );
    const highWatermark =
      input.highWatermark ?? Math.max(max[0]!.sequence, retention.checkpointSequence);
    if (input.afterSequence > highWatermark)
      return yield* new MemoryStoreConflict({ code: "invalid_cursor" });
    const rows = yield* stored(
      "hub-tail",
      sql<{
        entry_json: string;
      }>`SELECT entry_json FROM memory_hub_operations WHERE space=${input.memorySpaceId} AND hub_sequence>${input.afterSequence} AND hub_sequence<=${highWatermark} ORDER BY hub_sequence LIMIT ${Math.max(1, Math.min(input.limit, M.MEMORY_PAGE_MAX_ITEMS)) + 1}`,
    );
    const entries: M.MemoryHubEntry[] = [];
    const maxBytes = Math.min(input.maxBytes, 262144);
    for (const row of rows.slice(0, Math.max(1, Math.min(input.limit, M.MEMORY_PAGE_MAX_ITEMS)))) {
      const entry = yield* hubEntryCodec.decode(row.entry_json, strict);
      const next = [...entries, entry];
      const size = new TextEncoder().encode(
        yield* codec(M.MemoryHubPullResult).encode({
          entries: next,
          highWatermark,
          throughSequence: entry.hubSequence,
          hasMore: true,
        }),
      ).length;
      if (size > maxBytes) break;
      entries.push(entry);
    }
    if (rows.length && entries.length === 0)
      return yield* new M.MemoryHubError({ code: "payload_too_large" });
    const throughSequence = entries.at(-1)?.hubSequence ?? input.afterSequence;
    return { entries, highWatermark, throughSequence, hasMore: rows.length > entries.length };
  });
  const transitionHubLeaseTx: MemoryStore["Service"]["transitionHubLeaseTx"] = Effect.fn(
    "MemoryStore.transitionHubLeaseTx",
  )(function* (input) {
    yield* Transaction;
    yield* input.authority.reauthorize;
    const member = yield* requireHubMemberTx(input.authority.principal);
    const now = yield* input.authority.now;
    const action = input.action;
    const space = member.memorySpaceId;
    const memoryId = action.kind === "invalidate" ? action.memoryId : action.request.memoryId;
    const current = yield* loadAggregate(
      space,
      memoryId,
      {},
      action.kind === "claim" ? { conflictId: action.request.conflictId } : {},
    );
    const rows = yield* stored(
      "hub-lease",
      sql<{
        highest_token: number;
        lease_json: string | null;
      }>`SELECT * FROM memory_hub_leases WHERE space=${space} AND memory_id=${memoryId}`,
    );
    const lease = rows[0]?.lease_json
      ? yield* codec(M.MemoryResolutionLease).decode(rows[0].lease_json, strict)
      : null;
    const highest = Math.max(rows[0]?.highest_token ?? 0, current.fence?.highestFencingToken ?? 0);
    let next: M.MemoryResolutionLease | null = null;
    let token = highest;
    if (action.kind === "invalidate") {
      if (highest !== action.expectedToken) return null;
      token = highest + 1;
    } else {
      const r = action.request;
      if (r.memorySpaceId !== space || r.holderEnvironmentId !== member.environmentId)
        return yield* new M.MemoryHubForbiddenError({});
      if (action.kind === "claim") {
        const requestDigest = hashText(yield* claimCodec.encode(action.request));
        const attempts = yield* stored(
          "hub-attempt-replay",
          sql<{
            record_json: string;
            memory_id: string;
          }>`SELECT record_json,memory_id FROM memory_import_keys WHERE space=${space} AND key_kind='hub_attempt' AND key=${r.attemptId}`,
        );
        const attempt = attempts[0]
          ? yield* codec(HubAttemptReplay).decode(attempts[0].record_json, strict)
          : null;
        if (attempt) {
          if (attempts[0]!.memory_id !== memoryId || attempt.requestDigest !== requestDigest)
            return yield* new M.MemoryHubError({ code: "identity_mismatch" });
          if (attempt.deadline <= now)
            return yield* new M.MemoryHubError({ code: "lease_expired" });
          if (lease?.attemptId !== r.attemptId || lease.fencingToken !== attempt.fencingToken)
            return yield* new M.MemoryHubError({ code: "fenced" });
        }
        if (lease?.attemptId === r.attemptId) {
          if (
            Date.parse(lease.expiresAtHubTime) <= now ||
            Date.parse(lease.attemptDeadlineHubTime) <= now
          )
            return yield* new M.MemoryHubError({ code: "lease_expired" });
          if (
            current.tombstone ||
            current.pendingForget ||
            !sameHeadSet(current.heads, lease.conflictHeadSet)
          )
            return yield* new M.MemoryHubError({ code: "conflict_changed" });
          if (
            lease.holderEnvironmentId !== r.holderEnvironmentId ||
            lease.conflictId !== r.conflictId ||
            !sameHeadSet(lease.conflictHeadSet, action.request.conflictHeadSet) ||
            (yield* selectionCodec.encode(lease.frozenDefaultModelSelection)) !==
              (yield* selectionCodec.encode(action.request.frozenDefaultModelSelection))
          )
            return yield* new M.MemoryHubError({ code: "identity_mismatch" });
          return lease;
        }
        if (lease && Date.parse(lease.expiresAtHubTime) > now)
          return yield* new M.MemoryHubError({ code: "lease_required" });
        if (!current.identity || current.tombstone || current.pendingForget)
          return yield* new M.MemoryHubError({ code: "forgotten" });
        if (
          !sameHeadSet(current.heads, action.request.conflictHeadSet) ||
          !current.conflicts.some((c) => c.conflictId === r.conflictId && c.status !== "resolved")
        )
          return yield* new M.MemoryHubError({ code: "conflict_changed" });
        const count = yield* stored(
          "hub-attempt-count",
          sql<{
            count: number;
          }>`SELECT count(*) AS count FROM memory_import_keys WHERE space=${space} AND key_kind='hub_attempt'`,
        );
        if (count[0]!.count >= M.MEMORY_DEDUP_MAX_RECEIPTS)
          return yield* new MemoryCapacityError({
            dimension: "receipts",
            limit: M.MEMORY_DEDUP_MAX_RECEIPTS,
          });
        token = highest + 1;
        // Permanent bounded guard survives release, invalidate and replacement. Details remain transient.
        yield* stored(
          "hub-attempt-first",
          sql`INSERT INTO memory_import_keys(space,key_kind,key,memory_id,record_json) VALUES (${space},'hub_attempt',${r.attemptId},${memoryId},${yield* codec(HubAttemptReplay).encode({ requestDigest, claimedAt: now, deadline: now + M.MEMORY_RESOLUTION_ATTEMPT_MAX_MS, fencingToken: token })})`,
        );
        const iso = (time: number) =>
          M.MemoryUtcTimestamp.make(DateTime.formatIso(DateTime.makeUnsafe(time)));
        next = {
          memorySpaceId: space,
          memoryId,
          conflictId: r.conflictId,
          conflictHeadSet: action.request.conflictHeadSet,
          holderEnvironmentId: member.environmentId,
          attemptId: r.attemptId,
          frozenDefaultModelSelection: action.request.frozenDefaultModelSelection,
          fencingToken: token,
          claimedAtHubTime: iso(now),
          expiresAtHubTime: iso(now + M.MEMORY_LEASE_MS),
          attemptDeadlineHubTime: iso(now + M.MEMORY_RESOLUTION_ATTEMPT_MAX_MS),
        };
      } else {
        if (
          !lease ||
          lease.attemptId !== r.attemptId ||
          lease.holderEnvironmentId !== member.environmentId ||
          lease.conflictId !== r.conflictId ||
          lease.fencingToken !== action.request.fencingToken
        )
          return yield* new M.MemoryHubError({ code: "fenced" });
        if (action.kind === "renew") {
          if (
            Date.parse(lease.expiresAtHubTime) <= now ||
            Date.parse(lease.attemptDeadlineHubTime) <= now
          )
            return yield* new M.MemoryHubError({ code: "lease_expired" });
          if (
            current.tombstone ||
            current.pendingForget ||
            !sameHeadSet(current.heads, lease.conflictHeadSet)
          )
            return yield* new M.MemoryHubError({ code: "conflict_changed" });
          next = {
            ...lease,
            expiresAtHubTime: M.MemoryUtcTimestamp.make(
              DateTime.formatIso(
                DateTime.makeUnsafe(
                  Math.min(now + M.MEMORY_LEASE_MS, Date.parse(lease.attemptDeadlineHubTime)),
                ),
              ),
            ),
          };
        }
      }
    }
    if (!current.identity) return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
    const fence: M.MemoryFenceRecord = {
      memorySpaceId: space,
      memoryId,
      highestFencingToken: token,
      activeLease: next,
    };
    yield* stored(
      "hub-lease-update",
      sql`INSERT INTO memory_hub_leases(space,memory_id,highest_token,lease_json) VALUES (${space},${memoryId},${token},${next ? yield* codec(M.MemoryResolutionLease).encode(next) : null}) ON CONFLICT(space,memory_id) DO UPDATE SET highest_token=excluded.highest_token,lease_json=excluded.lease_json`,
    );
    yield* stored(
      "hub-identity-fence",
      sql`UPDATE memory_identity_ledger SET fence_json=${yield* fenceCodec.encode(fence)} WHERE space=${space} AND memory_id=${memoryId}`,
    );
    return action.kind === "release" ? { released: true } : next;
  });
  const settleMetadataEntryTx: MemoryStore["Service"]["settleMetadataEntryTx"] = Effect.fn(
    "MemoryStore.settleMetadataEntryTx",
  )(function* (input) {
    yield* Transaction;
    const entry = yield* stored("metadata-entry", hubEntryDecode(input.entry, strict));
    if (entry.kind !== "metadata")
      return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
    if (entry.compactReceipt && entry.compactReceipt.memorySpaceId !== input.memorySpaceId)
      return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
    const old = yield* receipt(input.memorySpaceId, entry.receipt.operationId);
    if (old && old.operationDigest !== entry.receipt.operationDigest)
      return yield* new MemoryStoreConflict({ code: "operation_id_reused" });
    const settledReceipt = {
      ...entry.receipt,
      ...(old?.receipt.forgetExpansion ? { forgetExpansion: old.receipt.forgetExpansion } : {}),
      ...(old?.receipt.forgetRetryOf ? { forgetRetryOf: old.receipt.forgetRetryOf } : {}),
    };
    if (
      old &&
      "hubSequence" in old.receipt &&
      old.receipt.hubSequence !== null &&
      (yield* receiptCodec.encode(old.receipt)) !== (yield* receiptCodec.encode(settledReceipt))
    )
      return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
    // Canonical replay may enrich receipts, but its domain incorporation already happened.
    const canonicalReplay = old && "hubSequence" in old.receipt && old.receipt.hubSequence !== null;
    if (entry.receipt.outcome !== "rejected" && entry.revision) {
      const revision = entry.revision;
      if (
        revision.memorySpaceId !== input.memorySpaceId ||
        revision.memoryId !== entry.memoryId ||
        revision.operationId !== entry.receipt.operationId
      )
        return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
      const current = yield* loadAggregate(
        input.memorySpaceId,
        entry.memoryId,
        { revisionIds: [revision.revisionId] },
        {},
      );
      if (current.identity) yield* persistImportLineageTx(lineageForRevision(revision));
      if (
        !canonicalReplay &&
        !current.tombstone &&
        !current.revisions.some(
          (pair) => pair.revision.revisionId === revision.revisionId && pair.payload !== null,
        )
      ) {
        yield* stored(
          "metadata-revision",
          sql`INSERT INTO memory_revisions(space,revision_id,memory_id,operation_id,parents_json,scope_json,assertion_kind,provenance_json,payload_ref,created_at) VALUES (${revision.memorySpaceId},${revision.revisionId},${revision.memoryId},${revision.operationId},${yield* headsCodec.encode(revision.parents)},${yield* scopeCodec.encode(revision.scope)},${revision.assertionKind},${yield* provenanceCodec.encode(revision.provenance)},${revision.payloadRef},${Date.parse(revision.createdAtUtc)}) ON CONFLICT(space,revision_id) DO NOTHING`,
        );
        // Preserve unrelated unsent heads; a missing body is a canonical availability state.
        const parents = new Set(revision.parents);
        const heads = [
          ...new Set([...current.heads.filter((id) => !parents.has(id)), revision.revisionId]),
        ];
        const watermark = yield* nextWatermark(input.memorySpaceId);
        yield* putItem(
          {
            memorySpaceId: input.memorySpaceId,
            memoryId: entry.memoryId,
            status: "blocked",
            scope: revision.scope,
            failureCode: "source_invalidated",
            pendingSync: false,
            localAvailability: {
              exposure: "held",
              reasons: ["dependency_invalidated"],
              deferred: [],
              cleanupPending: false,
            },
          },
          heads,
          watermark,
        );
        yield* emit({
          memorySpaceId: input.memorySpaceId,
          memoryId: entry.memoryId,
          kind: "invalidate",
          projectionWatermark: watermark,
        });
      }
    }
    if (entry.tombstone && !canonicalReplay) {
      if (
        entry.tombstone.memorySpaceId !== input.memorySpaceId ||
        entry.tombstone.memoryId !== entry.memoryId
      )
        return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
      const t = entry.tombstone;
      const watermark = yield* nextWatermark(input.memorySpaceId);
      yield* stored(
        "metadata-tombstone",
        sql`INSERT INTO memory_tombstones(space,memory_id,delete_operation_id,deleting_environment_id,deleted_at,suppressed_source_keys_json,suppressed_content_json,source_exclusions_json) VALUES (${input.memorySpaceId},${t.memoryId},${t.deleteOperationId},${t.deletingEnvironmentId},${Date.parse(t.deletedAtUtc)},'[]','[]','[]') ON CONFLICT(space,memory_id) DO NOTHING`,
      );
      yield* putItem(
        {
          memorySpaceId: input.memorySpaceId,
          memoryId: t.memoryId,
          status: "forgotten",
          tombstone: t,
          pendingSync: false,
          localAvailability: {
            exposure: "forgotten",
            reasons: [],
            deferred: [],
            cleanupPending: false,
          },
        },
        [],
        watermark,
      );
      yield* emit({
        memorySpaceId: input.memorySpaceId,
        memoryId: t.memoryId,
        kind: "forget",
        projectionWatermark: watermark,
      });
      yield* writeSuppressions(entry.tombstone);
      yield* purge(input.memorySpaceId, entry.memoryId, yield* nextWatermark(input.memorySpaceId));
    }
    yield* stored(
      "metadata-receipt-promotion",
      sql`UPDATE memory_events SET receipt_json=${yield* receiptCodec.encode(settledReceipt)} WHERE memory_space_id=${input.memorySpaceId} AND operation_id=${entry.receipt.operationId}`,
    );
    yield* settleImportOperationTx(input.memorySpaceId, settledReceipt);
    // A compact guard retains body-free approval even when no local operation body remains.
    const existing = yield* stored(
      "metadata-compact",
      sql`UPDATE memory_compact_receipts SET receipt_json=${yield* receiptCodec.encode(settledReceipt)},hub_sequence=${entry.hubSequence} WHERE space=${input.memorySpaceId} AND operation_id=${entry.receipt.operationId} RETURNING operation_id`,
    );
    if (entry.compactReceipt)
      yield* persistCompactReceipt({ ...entry.compactReceipt, receipt: settledReceipt });
    if (!entry.compactReceipt && !old && !existing.length)
      yield* stored(
        "metadata-ledger",
        sql`INSERT INTO memory_import_keys(space,key_kind,key,memory_id,record_json) VALUES (${input.memorySpaceId},'hubReceipt',${entry.receipt.operationId},${entry.memoryId},${yield* hubEntryCodec.encode(entry)}) ON CONFLICT(space,key_kind,key) DO NOTHING`,
      );
  });
  // Canonical operation settlement retains shared evidence independently of local delivery.
  const reconcileOperationReportTx: MemoryStore["Service"]["reconcileOperationReportTx"] =
    Effect.fn("MemoryStore.reconcileOperationReportTx")(function* (input) {
      yield* Transaction;
      const { operation: op, receipt } = input;
      if (
        (op.kind !== "resolve" && op.kind !== "revert") ||
        receipt.hubSequence === null ||
        !["accepted", "conflicted"].includes(receipt.outcome)
      )
        return;
      if (
        receipt.operationId !== op.operationId ||
        receipt.memoryId !== op.memoryId ||
        receipt.operationDigest !== hashText(M.encodeMemoryOperation(op)) ||
        !M.validateMemoryResolutionApproval(
          op.kind,
          op.kind === "resolve" ? op.resolution.resolutionId : op.revertsResolutionId,
          receipt,
        )
      )
        return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
      const existing = yield* stored(
        "operation-report-compact",
        sql<{
          compact_json: string;
        }>`SELECT compact_json FROM memory_compact_receipts WHERE space=${op.memorySpaceId} AND operation_id=${op.operationId}`,
      );
      const resolutionId =
        op.kind === "resolve" ? op.resolution.resolutionId : op.revertsResolutionId;
      const record: M.MemoryCompactReceipt = existing[0]
        ? yield* compactCodec.decode(existing[0].compact_json, strict)
        : {
            memorySpaceId: op.memorySpaceId,
            originEnvironmentId: op.originEnvironmentId,
            operationKind: op.kind,
            receipt,
            revisionId: op.revision.revisionId,
            resolutionId,
            revertsResolutionId: op.kind === "revert" ? resolutionId : null,
            attemptId: op.kind === "resolve" ? op.operationId : null,
            fencingToken: op.kind === "resolve" ? op.fencingToken : null,
            reportGuard: {
              reportId: resolutionReportId(op.memorySpaceId, op.operationId, resolutionId),
              resolvingEnvironmentId: op.originEnvironmentId,
              resolutionId,
              outcome: op.kind === "resolve" ? "resolved" : "reverted",
            },
          };
      if (
        record.operationKind !== op.kind ||
        record.originEnvironmentId !== op.originEnvironmentId ||
        record.resolutionId !== resolutionId ||
        record.revisionId !== op.revision.revisionId ||
        (yield* receiptCodec.encode(record.receipt)) !== (yield* receiptCodec.encode(receipt))
      )
        return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
      // Operation envelopes do not carry the original claim attempt ID. Use this
      // validated projection for delivery, but let canonical checkpoint receipts own
      // permanent compact metadata (including their immutable attempt identity).
      yield* reconcileResolutionReportTx({ record, localEnvironmentId: input.localEnvironmentId });
    });
  // Page the PK before inspecting ownership/evidence: ambiguous rows cannot starve later spaces.
  const normalizeForeignReportIntentsTx: MemoryStore["Service"]["normalizeForeignReportIntentsTx"] =
    Effect.fn("MemoryStore.normalizeForeignReportIntentsTx")(function* (
      localEnvironmentId,
      after = null,
    ) {
      yield* Transaction;
      const page = yield* stored(
        "foreign-report-page",
        after === null
          ? sql<{
              report_id: string;
              resolving_environment_id: string;
              state: string;
            }>`SELECT report_id,resolving_environment_id,state FROM memory_report_outbox ORDER BY report_id LIMIT 256`
          : sql<{
              report_id: string;
              resolving_environment_id: string;
              state: string;
            }>`SELECT report_id,resolving_environment_id,state FROM memory_report_outbox WHERE report_id>${after} ORDER BY report_id LIMIT 256`,
      );
      for (const candidate of page) {
        if (
          candidate.resolving_environment_id === localEnvironmentId ||
          candidate.state === "delivered"
        )
          continue;
        const rows = yield* stored(
          "foreign-report-evidence",
          sql<{
            compact_json: string;
          }>`SELECT c.compact_json FROM memory_report_outbox r JOIN memory_compact_receipts c ON c.space=r.space AND c.operation_id=r.operation_id WHERE r.report_id=${candidate.report_id}`,
        );
        for (const row of rows) {
          const record = yield* compactCodec
            .decode(row.compact_json, strict)
            .pipe(Effect.catch(() => Effect.succeed(undefined)));
          if (
            record?.reportGuard &&
            record.reportGuard.reportId === candidate.report_id &&
            record.reportGuard.reportId ===
              resolutionReportId(
                record.memorySpaceId,
                record.receipt.operationId,
                record.reportGuard.resolutionId,
              )
          )
            yield* reconcileResolutionReportTx({ record, localEnvironmentId });
        }
        // Older body-bearing receives may not have a compact checkpoint receipt yet.
        // Their canonical event metadata and approved receipt are sufficient without
        // loading payloads or inventing a missing claim attempt identity.
        const events = yield* stored(
          "foreign-report-events",
          sql<{
            report_id: string;
            metadata_json: string;
            receipt_json: string;
            operation_digest: string;
          }>`SELECT r.report_id,e.metadata_json,e.receipt_json,e.operation_digest FROM memory_report_outbox r JOIN memory_events e ON e.memory_space_id=r.space AND e.operation_id=r.operation_id WHERE r.report_id=${candidate.report_id}`,
        );
        for (const row of events) {
          const metadata = yield* metadataCodec
            .decode(row.metadata_json, strict)
            .pipe(Effect.orElseSucceed(() => undefined));
          const approval = yield* receiptCodec
            .decode(row.receipt_json, strict)
            .pipe(Effect.orElseSucceed(() => undefined));
          if (
            !metadata ||
            !approval ||
            !("hubSequence" in approval) ||
            approval.hubSequence === null ||
            !["accepted", "conflicted"].includes(approval.outcome) ||
            metadata.originEnvironmentId === localEnvironmentId ||
            approval.operationId !== metadata.operationId ||
            approval.memoryId !== metadata.memoryId ||
            approval.operationDigest !== row.operation_digest
          )
            continue;
          const resolutionId =
            metadata.kind === "resolve"
              ? metadata.resolution?.resolutionId
              : metadata.kind === "revert"
                ? metadata.revertsResolutionId
                : undefined;
          if (
            !resolutionId ||
            !M.validateMemoryResolutionApproval(metadata.kind, resolutionId, approval) ||
            (metadata.kind === "resolve" &&
              metadata.resolution?.resolvingEnvironmentId !== metadata.originEnvironmentId) ||
            row.report_id !==
              resolutionReportId(metadata.memorySpaceId, metadata.operationId, resolutionId)
          )
            continue;
          yield* stored(
            "foreign-report-event-intent",
            sql`DELETE FROM memory_report_outbox WHERE report_id=${row.report_id} AND space=${metadata.memorySpaceId} AND memory_id=${metadata.memoryId} AND operation_id=${metadata.operationId} AND resolution_id=${resolutionId} AND resolving_environment_id=${metadata.originEnvironmentId} AND outcome=${metadata.kind === "resolve" ? "resolved" : "reverted"} AND state!='delivered'`,
          );
        }
      }
      return {
        examined: page.length,
        nextCursor: page.length === 256 ? page[255]!.report_id : null,
      };
    });
  const reconcileResolutionReportTx: MemoryStore["Service"]["reconcileResolutionReportTx"] =
    Effect.fn("MemoryStore.reconcileResolutionReportTx")(function* (input) {
      yield* Transaction;
      const record = yield* stored(
        "report-compact",
        compactCodec.decode(yield* compactCodec.encode(input.record), strict),
      );
      const guard = record.reportGuard;
      if (!guard) return { reportId: null, deliverable: false };
      const reportId = resolutionReportId(
        record.memorySpaceId,
        record.receipt.operationId,
        guard.resolutionId,
      );
      if (guard.reportId !== reportId)
        return yield* new MemoryStoreConflict({ code: "identity_mismatch" });
      if (
        record.receipt.hubSequence === null ||
        !["accepted", "conflicted"].includes(record.receipt.outcome) ||
        !(
          (record.operationKind === "resolve" && guard.outcome === "resolved") ||
          (record.operationKind === "revert" && guard.outcome === "reverted")
        ) ||
        record.originEnvironmentId !== guard.resolvingEnvironmentId
      )
        return { reportId, deliverable: false };
      const deliverable = guard.resolvingEnvironmentId === input.localEnvironmentId;
      if (!deliverable) {
        // Only the exact canonical foreign delivery intent is disposable. Shared receipt
        // and delivered guards remain authoritative; unknown/contradictory rows stay put.
        yield* stored(
          "foreign-report-intent",
          sql`DELETE FROM memory_report_outbox WHERE report_id=${reportId} AND space=${record.memorySpaceId} AND memory_id=${record.receipt.memoryId} AND operation_id=${record.receipt.operationId} AND resolution_id=${guard.resolutionId} AND resolving_environment_id=${guard.resolvingEnvironmentId} AND outcome=${guard.outcome} AND state!='delivered'`,
        );
        return { reportId, deliverable };
      }
      const delivered = yield* stored(
        "report-delivered-guard",
        sql`SELECT 1 FROM memory_import_keys WHERE space=${record.memorySpaceId} AND key_kind='report_delivered' AND key=${reportId}`,
      );
      if (delivered.length) return { reportId, deliverable: false };
      yield* stored(
        "report-reconcile",
        sql`INSERT INTO memory_report_outbox(report_id,space,memory_id,operation_id,resolution_id,attempt_id,resolving_environment_id,outcome,state,created_at,report_kind,report_approved,attempts_known) VALUES (${reportId},${record.memorySpaceId},${record.receipt.memoryId},${record.receipt.operationId},${guard.resolutionId},${record.attemptId},${guard.resolvingEnvironmentId},${guard.outcome},'pending',${record.receipt.resolutionApproval ? Date.parse(record.receipt.resolutionApproval.appliedAtUtc) : 0},${record.operationKind === "resolve" ? "resolve" : "revert"},1,1) ON CONFLICT(report_id) DO UPDATE SET report_approved=1,report_kind=excluded.report_kind WHERE memory_report_outbox.space=excluded.space AND memory_report_outbox.memory_id=excluded.memory_id AND memory_report_outbox.operation_id=excluded.operation_id AND memory_report_outbox.resolving_environment_id=excluded.resolving_environment_id AND memory_report_outbox.resolution_id=excluded.resolution_id AND memory_report_outbox.outcome=excluded.outcome`,
      );
      const retained = yield* stored(
        "report-admission",
        sql`SELECT 1 FROM memory_report_outbox WHERE report_id=${reportId} AND report_approved=1`,
      );
      if (retained.length) yield* markRunnable;
      return { reportId, deliverable: retained.length === 1 };
    });
  return MemoryStore.of({
    readAccess,
    historyPage,
    recordRevertResultTx,
    prepareHubCheckpointTx: (input) => withHubBudget(prepareHubCheckpointTx(input)),
    prepareHubProducerCheckpointTx: (input) => withHubBudget(prepareHubProducerCheckpointTx(input)),
    readHubCheckpointPageTx,
    publishCheckpointAndFloorTx: (input) => withHubBudget(publishCheckpointAndFloorTx(input)),
    compactEligibleHistoryTx,
    purgeHubTransientTx,
    requestHubSourceReadTx: (authority, input) =>
      withHubBudget(requestHubSourceReadTx(authority, input)),
    collectHubSourceReadsTx,
    respondHubSourceReadTx: (authority, input) =>
      input.kind === "revoke"
        ? respondHubSourceReadTx(authority, input)
        : withHubBudget(respondHubSourceReadTx(authority, input)),
    resultHubSourceReadTx,
    readHubAdminTx,
    writeHubAdminTx: (input) => withHubBudget(writeHubAdminTx(input)),
    activateHubMemberTx: (input) => withHubBudget(activateHubMemberTx(input)),
    readPendingHubAdmins,
    hasHubAdministrationTx: () =>
      Effect.gen(function* () {
        yield* Transaction;
        const rows = yield* stored(
          "hub-admin-provenance",
          sql<{
            administered: number;
          }>`SELECT administered FROM memory_hub_administration_state WHERE singleton=1`,
        );
        return rows[0]?.administered === 1;
      }),
    readActivatedHubAdminTx,
    readProcessing,
    readLocalProcessingStatus,
    readBootstrap,
    discardBootstrapTx,
    retireFrozenClaimTx,
    advanceBootstrapTx,
    readHubMembers,
    readHubMember,
    findHubMemberByCredential,
    requireHubMemberTx,
    readHubReceiptTx,
    appendHubEntryTx: (input) =>
      input.operation.kind === "forget"
        ? appendHubEntryTx(input)
        : withHubBudget(appendHubEntryTx(input)),
    readHubTailTx,
    transitionHubLeaseTx: (input) => withHubBudget(transitionHubLeaseTx(input)),
    readHubRetentionTx,
    readHubUsageTx,
    readHubInventoryTx,
    reserveHubCheckpointTx: (input) => withHubBudget(reserveHubCheckpointTx(input)),
    settleMetadataEntryTx,
    reconcileResolutionReportTx,
    reconcileOperationReportTx,
    normalizeForeignReportIntentsTx,
    acquireSyncWorkTx,
    retrySyncWorkTx,
    readWorkHold,
    readPullRetry,
    readPersistedHoldClasses,
    writePullRetryTx,
    rearmSyncHoldsTx,
    prepareClaimAttemptTx,
    readRecoverableResolutionTickets,
    acquireResolutionTicketTx,
    transitionResolutionTicketTx,
    persistResolutionSubmissionTx,
    reconcileResolutionSubmissionTx,
    retireRejectedSubmissionTx,
    renewResolutionTicketTx,
    failResolutionTicketTx,
    holdClaimCandidateTx,
    holdResolutionAttemptTx,
    rearmResolutionHoldsTx,
    listMaterializableIntents,
    assignIntentIdentityTx,
    transact,
    receipt,
    readResolutionInputsPage,
    readResolutionSnapshot,
    readResolutionHeads,
    loadAggregate: (space, id, payloads, history) =>
      transact(loadAggregate(space, id, payloads, history)),
    apply: (decision) =>
      decision.admission.kind === "hubAdmission" && decision.operation.kind !== "forget"
        ? transact(withHubBudget(applyDecision(decision)))
        : applyDecision(decision),
    reconnectParked: (decision, generation) => applyDecision(decision, generation),
    readAncestry: (space, id, parents) => transact(readAncestry(space, id, parents)),
    withReceivedCursor,
    readCursor,
    readOperation,
    readWorkOperation,
    pendingReceived,
    stageRevertIntent,
    list: (filter) => transact(list(filter)),
    search: (filter, text, mode) =>
      Effect.gen(function* () {
        const coverage = yield* transact(searchCoverage(filter));
        if (!coverage.ready) {
          if (mode === "substring") return yield* new MemoryStoreConflict({ code: "unavailable" });
          return {
            items: [],
            examinedAfterMemoryId: filter.afterMemoryId ?? null,
            exhausted: false,
          };
        }
        return yield* transact(search(filter, text, mode));
      }),
    searchCoverage: (filter) => transact(searchCoverage(filter)),
    dueWork,
    readWork,
    retryWork,
    rearmGenerationWork,
    renewWork,
    rebindWorkModel,
    readThreadHookWatermark,
    cancelThreadWork,
    readThreadLineage,
    appendThreadLineage,
    deleteThreadLineage,
    commitThreadHook,
    readParked,
    enqueueWork,
    claimWork,
    finishWork,
    readEligibleOutbox,
    acknowledgeOutbox,
    preserveForgetIntent,
    enqueuePendingForget,
    forgetLocalIntent,
    pendingForgetIntents,
    settleForgetIntent,
    readDeferred,
    readScannerChunk,
    claimDeferred,
    finishDeferred,
    finishOwnedDeferred,
    completeSummaryWork,
    recoverDeferred,
    getProjectBinding,
    putProjectBinding,
    changes,
    reserve,
    usage,
    readForgetReservation,
    settleForgetExpansion,
    firstForgetReservation,
    operationMetadataBytes: (operation) =>
      Effect.map(
        metadataCodec.encode(metadataOf(operation)),
        (text) => new TextEncoder().encode(text).length,
      ),
    persistCompactReceipt,
    prunePayloads,
    readImportRegistrationTx,
    writeImportRegistrationTx: (input) => withHubBudget(writeImportRegistrationTx(input)),
    readImportBatchTx,
    readImportReceiptTx,
    readImportItemTx,
    commitImportItemTx: (input) => withHubBudget(commitImportItemTx(input)),
    findImportMatchTx,
    requireImportLineageCompleteTx,
    readImportLineage,
    unionImportLineageTx,
    readSuppressions,
    logicalBytes: logicalBytes(),
    counters,
    ftsState,
    putFtsState,
    index,
    measureAllocation,
    measuredMemoryBytes,
    pruneSettledSummaryWork,
    mergeFts,
    cleanupDerived,
    recordSample,
    samples,
    putLocalIntent,
    materializeLocalIntent,
    materializeLocalIntentTx,
    completeLocalIntentTx,
    readLocalSummaryPayload,
    refreshLocalSummaryIntent,
    installCheckpointPage,
    completeCheckpoint,
    readDueClaimCandidates,
    findClaimCandidate,
    recoverClaimCandidates,
    claimCandidate,
    retryClaimCandidate,
    completeClaimCandidate,
    persistResolutionTicket,
    readReportTarget,
    nextReportWakeAt,
    acquireReports,
    acknowledgeClaimedReport,
    deferClaimedReport,
    normalizeExpiredReports,
    resetReportAttemptsTx,
    purgeDeliveredReportDetailsTx,
    nextReportMaintenanceAt,
    pendingReports,
    claimReport,
    acknowledgeReport,
    failReport,
    failGenerationAttempt,
    wake,
    subscribeWake,
  });
});
export const layer = Layer.effect(MemoryStore, make);
