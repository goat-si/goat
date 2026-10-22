import { scanMemoryValue } from "./MemorySecretScanner.ts";
import * as M from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  adminActionCodec,
  adminCodec,
  adminReplayCodec,
  adminReplayJson,
  claimCodec,
  codec,
  decodeOperation,
  fenceCodec,
  handleCodec,
  headsCodec,
  hubEntryCodec,
  lineageForRevision,
  metadataCodec,
  metadataOf,
  provenanceCodec,
  receiptCodec,
  scopeCodec,
  selectionCodec,
  snapshotId,
  stored,
  stringArrayCodec,
} from "./store/StoreCodecs.ts";
import {
  AdminRecordSchema,
  HubAttemptReplay,
  MemoryCapacityError,
  MemoryStoreConflict,
  Transaction,
  hashText,
  resolutionReportId,
  sameHeadSet,
  strict,
} from "./store/StoreModel.ts";
import type { HubMember } from "./store/StoreModel.ts";
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
    changes,
    counters,
    subscribeWake,
  } = kernel;
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
  const { handlesFor } = hubSnapshotReads;
  const itemWrites = makeItemWrites(kernel, coreReads, hubSnapshotReads);
  const { putItem, enqueueWork, purge, writeSuppressions } = itemWrites;
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
  const {
    settleImportOperationTx,
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
  const {
    readHubMembers,
    readHubMember,
    findHubMemberByCredential,
    requireHubMemberTx,
    authorizeSource,
  } = hubMembership;
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
