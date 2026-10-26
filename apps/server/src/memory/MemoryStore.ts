import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { metadataCodec, metadataOf, stored } from "./store/StoreCodecs.ts";
import { MemoryStoreConflict, Transaction } from "./store/StoreModel.ts";
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
import { makeWorkQueue } from "./store/WorkQueue.ts";
import { makeOutbox } from "./store/Outbox.ts";
import { makeDeferredWork } from "./store/DeferredWork.ts";
import { makeProjectBindings } from "./store/ProjectBindings.ts";
import { makeStorageMaintenance } from "./store/StorageMaintenance.ts";
import { makeCompaction } from "./store/Compaction.ts";
import { makeRevertIntents } from "./store/RevertIntents.ts";
import { makeClaimCandidates } from "./store/ClaimCandidates.ts";
import { makeSyncHolds } from "./store/SyncHolds.ts";
import { makeResolutionTickets } from "./store/ResolutionTickets.ts";
import { makeReports } from "./store/Reports.ts";
import { makeCheckpoints } from "./store/Checkpoints.ts";
import { makeLocalIntents } from "./store/LocalIntents.ts";
import { makeHubMembership } from "./store/HubMembership.ts";
import { makeHubUsage } from "./store/HubUsage.ts";
import { makeHubLedger } from "./store/HubLedger.ts";
import { makeHubAdmin } from "./store/HubAdmin.ts";
import { makeSourceReads } from "./store/SourceReads.ts";
import { makeHubWrite } from "./store/HubWrite.ts";

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
  const { sql, wake, transact, withHubBudget, changes, counters, subscribeWake } = kernel;
  const coreReads = makeCoreReads(kernel);
  const {
    receipt,
    readAncestry,
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
  const { recordRevertResultTx } = revertResults;
  const hubSnapshotReads = makeHubSnapshotReads(kernel);

  const itemWrites = makeItemWrites(kernel, coreReads, hubSnapshotReads);
  const { enqueueWork } = itemWrites;
  const accounting = makeAccounting(kernel, coreReads, revertResults);
  const {
    reserve,
    settleForgetExpansion,
    readForgetReservation,
    firstForgetReservation,
    usage,
    persistCompactReceipt,
  } = accounting;
  const ftsIndex = makeFtsIndex(kernel, coreReads);
  const { index } = ftsIndex;
  const importLineage = makeImportLineage(kernel, coreReads, accounting);
  const { requireImportLineageCompleteTx, unionImportLineageTx } = importLineage;
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
  const workQueue = makeWorkQueue(kernel, itemWrites);
  const {
    readWork,
    readThreadLineage,
    appendThreadLineage,
    deleteThreadLineage,
    retryWork,
    rearmGenerationWork,
    renewWork,
    rebindWorkModel,
    cancelThreadWork,
    readThreadHookWatermark,
    commitThreadHook,
    dueWork,
    claimWork,
    finishWork,
  } = workQueue;
  const outbox = makeOutbox(kernel, coreReads, revertResults, itemWrites, importLineage, workQueue);
  const {
    readEligibleOutbox,
    acknowledgeOutbox,
    preserveForgetIntent,
    enqueuePendingForget,
    pendingForgetIntents,
    settleForgetIntent,
  } = outbox;
  const deferredWork = makeDeferredWork(kernel, coreReads, workQueue);
  const {
    readDeferred,
    readScannerChunk,
    claimDeferred,
    finishDeferred,
    finishOwnedDeferred,
    completeSummaryWork,
    recoverDeferred,
  } = deferredWork;
  const projectBindings = makeProjectBindings(kernel);
  const { getProjectBinding, putProjectBinding } = projectBindings;
  const storageMaintenance = makeStorageMaintenance(kernel);
  const {
    ftsState,
    putFtsState,
    measureAllocation,
    mergeFts,
    measuredMemoryBytes,
    pruneSettledSummaryWork,
    recordSample,
    samples,
  } = storageMaintenance;
  const compaction = makeCompaction(kernel);
  const { prunePayloads, forgetLocalIntent, cleanupDerived } = compaction;
  const revertIntents = makeRevertIntents(kernel, coreReads, revertResults, itemWrites);
  const { stageRevertIntent } = revertIntents;
  const claimCandidates = makeClaimCandidates(kernel, coreReads, itemWrites, workQueue);
  const {
    readDueClaimCandidates,
    findClaimCandidate,
    recoverClaimCandidates,
    claimCandidate,
    retryClaimCandidate,
    completeClaimCandidate,
    persistResolutionTicket,
  } = claimCandidates;
  const syncHolds = makeSyncHolds(kernel, coreReads);
  const {
    acquireSyncWorkTx,
    retrySyncWorkTx,
    readPullRetry,
    readPersistedHoldClasses,
    writePullRetryTx,
    readWorkHold,
    rearmSyncHoldsTx,
  } = syncHolds;
  const resolutionTickets = makeResolutionTickets(
    kernel,
    coreReads,
    workQueue,
    claimCandidates,
    revertIntents,
    syncHolds,
  );
  const {
    prepareClaimAttemptTx,
    readRecoverableResolutionTickets,
    acquireResolutionTicketTx,
    transitionResolutionTicketTx,
    reconcileResolutionSubmissionTx,
    retireRejectedSubmissionTx,
    renewResolutionTicketTx,
    failResolutionTicketTx,
    holdClaimCandidateTx,
    holdResolutionAttemptTx,
    rearmResolutionHoldsTx,
    persistResolutionSubmissionTx,
    listMaterializableIntents,
    assignIntentIdentityTx,
  } = resolutionTickets;
  const reports = makeReports(kernel, workQueue);
  const {
    normalizeExpiredReports,
    readReportTarget,
    nextReportWakeAt,
    acquireReports,
    acknowledgeClaimedReport,
    deferClaimedReport,
    resetReportAttemptsTx,
    purgeDeliveredReportDetailsTx,
    nextReportMaintenanceAt,
    pendingReports,
    claimReport,
    acknowledgeReport,
    failGenerationAttempt,
    failReport,
    reconcileOperationReportTx,
    normalizeForeignReportIntentsTx,
    reconcileResolutionReportTx,
  } = reports;
  const checkpoints = makeCheckpoints(
    kernel,
    coreReads,
    itemWrites,
    accounting,
    importLineage,
    reports,
  );
  const { installCheckpointPage, completeCheckpoint } = checkpoints;
  const localIntents = makeLocalIntents(kernel, coreReads);
  const {
    putLocalIntent,
    readLocalSummaryPayload,
    refreshLocalSummaryIntent,
    materializeLocalIntentTx,
    materializeLocalIntent,
    completeLocalIntentTx,
  } = localIntents;
  const hubMembership = makeHubMembership(kernel);
  const { readHubMembers, readHubMember, findHubMemberByCredential, requireHubMemberTx } =
    hubMembership;
  const hubUsage = makeHubUsage(kernel);
  const { readHubUsageTx, readHubInventoryTx, reserveHubCheckpointTx } = hubUsage;
  const hubLedger = makeHubLedger(
    kernel,
    hubSnapshotReads,
    importLineage,
    reports,
    hubMembership,
    hubUsage,
  );
  const {
    readHubReceiptTx,
    readHubRetentionTx,
    prepareHubProducerCheckpointTx,
    prepareHubCheckpointTx,
    readHubCheckpointPageTx,
    publishCheckpointAndFloorTx,
    compactEligibleHistoryTx,
  } = hubLedger;
  const hubAdmin = makeHubAdmin(kernel, coreReads, hubSnapshotReads, hubMembership, hubLedger);
  const {
    readHubAdminTx,
    writeHubAdminTx,
    readActivatedHubAdminTx,
    readPendingHubAdmins,
    activateHubMemberTx,
    readProcessing,
    readLocalProcessingStatus,
    readBootstrap,
    discardBootstrapTx,
    retireFrozenClaimTx,
    advanceBootstrapTx,
  } = hubAdmin;
  const sourceReads = makeSourceReads(
    kernel,
    coreReads,
    hubSnapshotReads,
    hubMembership,
    hubLedger,
  );
  const {
    purgeHubTransientTx,
    requestHubSourceReadTx,
    collectHubSourceReadsTx,
    respondHubSourceReadTx,
    resultHubSourceReadTx,
  } = sourceReads;
  const hubWrite = makeHubWrite(
    kernel,
    coreReads,
    itemWrites,
    accounting,
    importLineage,
    hubMembership,
    hubUsage,
    hubLedger,
  );
  const { appendHubEntryTx, readHubTailTx, transitionHubLeaseTx, settleMetadataEntryTx } = hubWrite;

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
