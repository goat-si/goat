import type * as M from "@goat/contracts";
import type * as Effect from "effect/Effect";
import type {
  LocalMemoryIntent,
  MemoryCapacityError,
  MemoryStorageError,
  MemoryStoreConflict,
  MemoryWork,
} from "./StoreModel.ts";
import type {
  AdminRecord,
  AdminReplay,
  AssignedIntent,
  CheckpointStageIdentity,
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
  MemoryHoldClass,
  PullRetryState,
  SubmissionReconciliation,
  SyncWorkOwner,
  TicketKey,
  TicketOwner,
  TicketRow,
  TicketState,
  WorkHold,
} from "./StoreModel.ts";

export interface SyncStoreShape {
  readonly acquireSyncWorkTx: (input: {
    workId: string;
    operationId: M.MemoryOperationId;
    operationDigest: string;
    owner: string;
    expectedVersion: number;
    now: number;
    ownedUntil: number;
  }) => InTx<SyncWorkOwner | null>;
  readonly retrySyncWorkTx: (input: {
    ownership: SyncWorkOwner;
    now: number;
    nextAttemptAt: number;
    failureCode: M.MemoryFailureCode | null;
    holdClass?: MemoryHoldClass;
  }) => InTx<boolean>;
  readonly readPullRetry: (input: {
    memorySpaceId: M.MemorySpaceId;
    hubEnvironmentId: M.EnvironmentId;
  }) => Effect.Effect<PullRetryState, MemoryStorageError>;
  readonly readPersistedHoldClasses: (input: {
    memorySpaceId: M.MemorySpaceId;
    hubEnvironmentId: M.EnvironmentId;
  }) => Effect.Effect<readonly MemoryHoldClass[], MemoryStorageError>;
  readonly writePullRetryTx: (input: {
    memorySpaceId: M.MemorySpaceId;
    hubEnvironmentId: M.EnvironmentId;
    expectedVersion: number;
    retry: Omit<PullRetryState, "version">;
  }) => InTx<PullRetryState | null>;
  readonly readWorkHold: (workId: string) => Effect.Effect<WorkHold | null, MemoryStorageError>;
  readonly rearmSyncHoldsTx: (input: {
    memorySpaceId: M.MemorySpaceId;
    holdClass: MemoryHoldClass;
    now: number;
    afterId: string;
    limit: number;
  }) => InTx<HoldRearmPage>;
  readonly prepareClaimAttemptTx: (input: {
    memorySpaceId: M.MemorySpaceId;
    candidateId: string;
    expectedGeneration: number;
    conflictHeads: readonly M.MemoryRevisionId[];
    proposedClaim?: M.MemoryHubClaimInput;
  }) => InTx<{ claim: M.MemoryHubClaimInput; generation: number } | null>;
  readonly readRecoverableResolutionTickets: (input: {
    memorySpaceId: M.MemorySpaceId;
    now: number;
    limit: number;
  }) => Effect.Effect<readonly TicketRow[], MemoryStorageError>;
  readonly acquireResolutionTicketTx: (input: {
    key: TicketKey;
    expectedVersion: number;
    owner: string;
    coordinatorEpoch: number;
    now: number;
    ownedUntil: number;
  }) => InTx<TicketRow | null>;
  readonly transitionResolutionTicketTx: (input: {
    ownership: TicketOwner;
    nextState: TicketState;
    now: number;
    ownedUntil: number | null;
    nextAttemptAt: number;
    approval?: M.MemoryHubReceipt;
    retireClaim?: { candidateId?: string; expectedGeneration: number; attemptId: string };
  }) => InTx<TicketRow | null>;
  readonly reconcileResolutionSubmissionTx: (input: {
    ownership: TicketOwner;
    now: number;
    rejection?: M.MemoryHubReceipt;
  }) => InTx<SubmissionReconciliation | null>;
  readonly retireRejectedSubmissionTx: (input: {
    ownership: TicketOwner;
    candidateId: string;
    expectedGeneration: number;
    rejection: M.MemoryHubReceipt;
    now: number;
    nextAttemptAt: number;
  }) => InTx<TicketRow | null>;
  readonly renewResolutionTicketTx: (input: {
    ownership: TicketOwner;
    now: number;
    expectedExpiresAtHubTime: M.MemoryResolutionLease["expiresAtHubTime"];
    renewedLease: M.MemoryResolutionLease;
  }) => InTx<TicketRow | null>;
  readonly failResolutionTicketTx: (input: {
    ownership: TicketOwner;
    now: number;
    failureCode: M.MemoryFailureCode;
    nextAttemptAt: number;
    holdClass?: MemoryHoldClass;
    reportConflictFailure: boolean;
  }) => InTx<TicketRow | null>;
  readonly holdClaimCandidateTx: (input: {
    memorySpaceId: M.MemorySpaceId;
    candidateId: string;
    expectedGeneration: number;
    expectedAttempt: number;
    attemptId: M.MemoryOperationId;
    coordinatorEpoch: number;
    now: number;
    failureCode: M.MemoryFailureCode;
    holdClass: MemoryHoldClass;
  }) => InTx<boolean>;
  readonly holdResolutionAttemptTx: (input: {
    ownership: TicketOwner;
    candidateId: string;
    expectedGeneration: number;
    expectedAttempt: number;
    now: number;
    failureCode: M.MemoryFailureCode;
    holdClass: MemoryHoldClass;
  }) => InTx<TicketRow | null>;
  readonly rearmResolutionHoldsTx: (input: {
    memorySpaceId: M.MemorySpaceId;
    holdClass: MemoryHoldClass;
    now: number;
    afterId: string;
    limit: number;
  }) => InTx<HoldRearmPage>;
  readonly persistResolutionSubmissionTx: (input: {
    ownership: TicketOwner;
    submission: M.MemoryHubApplyResolutionInput;
    digest: string;
  }) => InTx<TicketRow>;
  readonly listMaterializableIntents: (
    environment: M.EnvironmentId,
    limit: number,
  ) => Effect.Effect<readonly LocalMemoryIntent[], MemoryStorageError>;
  readonly assignIntentIdentityTx: (input: {
    environmentId: M.EnvironmentId;
    intentId: string;
    memorySpaceId: M.MemorySpaceId;
    operationId: M.MemoryOperationId;
    revisionId: M.MemoryRevisionId;
  }) => InTx<AssignedIntent>;
  readonly readHubMembers: (
    space: M.MemorySpaceId,
  ) => Effect.Effect<readonly M.MemoryHubMemberView[], MemoryStorageError>;
  readonly readHubMember: (
    space: M.MemorySpaceId,
    environment: M.EnvironmentId,
  ) => Effect.Effect<HubMember | undefined, MemoryStorageError>;
  readonly findHubMemberByCredential: (
    credentialDigest: string,
  ) => Effect.Effect<HubMember | undefined, MemoryStorageError>;
  readonly requireHubMemberTx: (
    principal: M.MemoryHubPrincipal,
  ) => InTx<
    HubMember,
    MemoryStorageError | M.MemoryHubUnauthorizedError | M.MemoryHubForbiddenError
  >;
  readonly readHubReceiptTx: (
    space: M.MemorySpaceId,
    operationId: M.MemoryOperationId,
  ) => InTx<HubLedgerRecord | undefined>;
  readonly appendHubEntryTx: (input: {
    operation: M.MemoryOperation;
    operationDigest: string;
    outcome: M.MemoryHubReceipt["outcome"];
    failureCode?: M.MemoryFailureCode;
    capacity?: M.MemoryCapacityExceeded;
    resolutionApproval?: M.MemoryResolutionApproval;
    now: number;
  }) => InTx<HubLedgerRecord, MemoryStorageError | MemoryStoreConflict | MemoryCapacityError>;
  readonly readHubTailTx: (input: {
    memorySpaceId: M.MemorySpaceId;
    afterSequence: number;
    highWatermark: number | null;
    limit: number;
    maxBytes: number;
  }) => InTx<M.MemoryHubPullResult, MemoryStorageError | MemoryStoreConflict | M.MemoryHubError>;
  readonly transitionHubLeaseTx: (input: {
    authority: HubAuthority;
    action:
      | { kind: "claim"; request: M.MemoryHubClaimInput }
      | { kind: "renew"; request: M.MemoryHubRenewInput }
      | { kind: "release"; request: M.MemoryHubReleaseInput }
      | {
          kind: "invalidate";
          memoryId: M.MemoryId;
          expectedToken: number;
          reason: "heads" | "forget" | "revoke";
        };
  }) => InTx<
    M.MemoryResolutionLease | M.MemoryHubReleaseResult | null,
    | MemoryStorageError
    | MemoryStoreConflict
    | MemoryCapacityError
    | M.MemoryHubError
    | M.MemoryHubUnauthorizedError
    | M.MemoryHubForbiddenError
  >;
  readonly readHubAdminTx: (
    requestId: M.MemoryOperationId,
  ) => InTx<AdminRecord | AdminReplay | undefined>;
  readonly writeHubAdminTx: (input: {
    record: AdminRecord;
    expectedStage: AdminRecord["stage"] | null;
  }) => InTx<AdminRecord, MemoryStorageError | MemoryStoreConflict | MemoryCapacityError>;
  readonly activateHubMemberTx: (input: {
    requestId: M.MemoryOperationId;
    requestDigest: string;
    memorySpaceId: M.MemorySpaceId;
    environmentId: M.EnvironmentId;
    expectedCredentialVersion: number | null;
    next: { credentialDigest: string } | "revoked";
    now: number;
  }) => InTx<HubMember, MemoryStorageError | MemoryStoreConflict | MemoryCapacityError>;
  readonly hasHubAdministrationTx: () => InTx<boolean, MemoryStorageError>;
  readonly readActivatedHubAdminTx: () => InTx<AdminRecord | undefined, MemoryStorageError>;
  readonly readPendingHubAdmins: (
    limit: number,
  ) => Effect.Effect<readonly AdminRecord[], MemoryStorageError>;
  readonly readProcessing: (input: {
    memorySpaceId: M.MemorySpaceId;
    hubEnvironmentId: M.EnvironmentId;
  }) => Effect.Effect<
    {
      processing: M.MemoryProcessingStatus;
      pendingSync: number;
      quarantined: number;
      parked: number;
    },
    MemoryStorageError
  >;
  readonly readLocalProcessingStatus: (input: {
    environmentId: M.EnvironmentId;
    memorySpaceId: M.MemorySpaceId | null;
    hubEnvironmentId: M.EnvironmentId | null;
  }) => Effect.Effect<
    {
      processing: M.MemoryProcessingStatus;
      pendingSync: number;
      quarantined: number;
      parked: number;
    },
    MemoryStorageError
  >;
  readonly readBootstrap: (input: {
    memorySpaceId: M.MemorySpaceId;
    hubEnvironmentId: M.EnvironmentId;
  }) => Effect.Effect<
    {
      state: "unbound" | "staging" | "ready";
      checkpointId: string | null;
      snapshotToken: string | null;
      checkpointSequence: number;
      cursor: string | null;
      pageCount: number;
      afterSequence: number;
      lastSuccessAt: number | null;
    },
    MemoryStorageError
  >;
  readonly discardBootstrapTx: (input: {
    memorySpaceId: M.MemorySpaceId;
    hubEnvironmentId: M.EnvironmentId;
    expectedSnapshotToken: string;
    expectedCheckpointId: string;
    expectedCheckpointSequence: number;
  }) => InTx<boolean>;
  readonly retireFrozenClaimTx: (input: {
    memorySpaceId: M.MemorySpaceId;
    candidateId: string;
    expectedGeneration: number;
    attemptId: M.MemoryOperationId;
    frozenHeads: readonly M.MemoryRevisionId[];
    nextAttemptAt: number;
  }) => InTx<boolean>;
  readonly advanceBootstrapTx: (input: {
    memorySpaceId: M.MemorySpaceId;
    hubEnvironmentId: M.EnvironmentId;
    expectedState: "unbound" | "staging" | "ready";
    nextState: "staging" | "ready";
    checkpointId: string;
    snapshotToken: string | null;
    checkpointSequence: number;
    nextCursor: string | null;
  }) => InTx<void>;
  readonly purgeHubTransientTx: (input: {
    memorySpaceId: M.MemorySpaceId;
    memoryId?: M.MemoryId;
    now: number;
    limit: number;
  }) => InTx<{ removedRows: number; cleanupPending: boolean }>;
  readonly requestHubSourceReadTx: (
    authority: HubAuthority,
    input: M.MemoryHubSourceReadRequestInput,
  ) => InTx<
    M.MemoryHubSourceReadRequestResult,
    | MemoryStorageError
    | MemoryStoreConflict
    | MemoryCapacityError
    | M.MemoryHubError
    | M.MemoryHubUnauthorizedError
    | M.MemoryHubForbiddenError
  >;
  readonly collectHubSourceReadsTx: (
    authority: HubAuthority,
    input: M.MemoryHubSourceReadCollectInput,
  ) => InTx<
    M.MemoryHubSourceReadCollectResult,
    | MemoryStorageError
    | MemoryStoreConflict
    | M.MemoryHubError
    | M.MemoryHubUnauthorizedError
    | M.MemoryHubForbiddenError
  >;
  readonly respondHubSourceReadTx: (
    authority: HubAuthority,
    input: M.MemoryHubSourceReadRespondInput,
  ) => InTx<
    M.MemoryHubSourceReadRespondResult,
    | MemoryStorageError
    | MemoryStoreConflict
    | MemoryCapacityError
    | M.MemoryHubError
    | M.MemoryHubUnauthorizedError
    | M.MemoryHubForbiddenError
  >;
  readonly resultHubSourceReadTx: (
    authority: HubAuthority,
    input: M.MemoryHubSourceReadResultInput,
  ) => InTx<
    M.MemoryHubSourceReadResultResult,
    | MemoryStorageError
    | MemoryStoreConflict
    | M.MemoryHubError
    | M.MemoryHubUnauthorizedError
    | M.MemoryHubForbiddenError
  >;
  readonly prepareHubCheckpointTx: (input: {
    authority: HubAuthority;
    checkpointId: string;
    snapshotToken: string;
    hubEnvironmentId: M.EnvironmentId;
  }) => InTx<
    HubCheckpointHandle,
    | MemoryStorageError
    | MemoryStoreConflict
    | MemoryCapacityError
    | M.MemoryHubError
    | M.MemoryHubUnauthorizedError
    | M.MemoryHubForbiddenError
  >;
  readonly prepareHubProducerCheckpointTx: (input: {
    authority: HubAuthority;
    checkpointId: string;
    hubEnvironmentId: M.EnvironmentId;
  }) => InTx<
    { readonly checkpointId: string; readonly checkpointSequence: number },
    | MemoryStorageError
    | MemoryStoreConflict
    | MemoryCapacityError
    | M.MemoryHubError
    | M.MemoryHubUnauthorizedError
    | M.MemoryHubForbiddenError
  >;
  readonly readHubCheckpointPageTx: (input: {
    authority: HubAuthority;
    snapshotToken: string;
    cursor: string | null;
  }) => InTx<
    M.MemoryHubCheckpointPage,
    | MemoryStorageError
    | MemoryStoreConflict
    | M.MemoryHubError
    | M.MemoryHubUnauthorizedError
    | M.MemoryHubForbiddenError
  >;
  readonly publishCheckpointAndFloorTx: (input: {
    memorySpaceId: M.MemorySpaceId;
    checkpointId: string;
    expectedFloor: number;
    nextFloor: number;
    now: number;
  }) => InTx<HubRetention, MemoryStorageError | MemoryStoreConflict | MemoryCapacityError>;
  readonly compactEligibleHistoryTx: (input: {
    memorySpaceId: M.MemorySpaceId;
    expectedFloor: number;
    now: number;
    limit: number;
  }) => InTx<M.MemoryCompactionStatus>;
  readonly readHubRetentionTx: (space: M.MemorySpaceId) => InTx<HubRetention>;
  readonly readHubUsageTx: (space: M.MemorySpaceId) => InTx<HubUsage>;
  readonly readHubInventoryTx: (space: M.MemorySpaceId) => InTx<{
    reserved: Partial<Record<M.MemoryCapacityDimension, number>>;
    reclaimable: Partial<Record<M.MemoryCapacityDimension, number>>;
  }>;
  readonly reserveHubCheckpointTx: (input: {
    memorySpaceId: M.MemorySpaceId;
    checkpointDeltaBytes: number;
    publishedPinnedDeltaBytes: number;
  }) => InTx<HubUsage, MemoryStorageError | MemoryStoreConflict | MemoryCapacityError>;
  readonly settleMetadataEntryTx: (input: {
    memorySpaceId: M.MemorySpaceId;
    entry: Extract<M.MemoryHubEntry, { kind: "metadata" }>;
  }) => InTx<void>;
  readonly normalizeForeignReportIntentsTx: (
    localEnvironmentId: M.EnvironmentId,
    after?: string | null,
  ) => InTx<{ examined: number; nextCursor: string | null }>;
  readonly reconcileOperationReportTx: (input: {
    operation: M.MemoryOperation;
    receipt: M.MemoryHubReceipt;
    localEnvironmentId: M.EnvironmentId;
  }) => InTx<void>;
  readonly reconcileResolutionReportTx: (input: {
    record: M.MemoryCompactReceipt;
    localEnvironmentId: M.EnvironmentId;
  }) => InTx<{ reportId: M.MemoryReportDelivery["reportId"] | null; deliverable: boolean }>;
  readonly pendingReceived: (
    space: M.MemorySpaceId,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<M.MemoryOperation | undefined>, MemoryStorageError>;
  readonly stageRevertIntent: (input: {
    readonly operation: Extract<M.MemoryOperation, { kind: "revert" }>;
    readonly requestDigest: string;
  }) => Effect.Effect<void, MemoryStorageError | MemoryStoreConflict | MemoryCapacityError>;
  readonly readParked: (
    limit: number,
  ) => Effect.Effect<ReadonlyArray<M.MemoryOperation>, MemoryStorageError>;
  readonly forgetLocalIntent: (
    environmentId: M.EnvironmentId,
    intentId: string,
  ) => Effect.Effect<void, MemoryStorageError | MemoryStoreConflict>;
  readonly prunePayloads: (now: number, limit: number) => Effect.Effect<number, MemoryStorageError>;
  readonly cleanupDerived: (limit: number) => Effect.Effect<number, MemoryStorageError>;
  readonly putLocalIntent: (
    input: LocalMemoryIntent,
  ) => Effect.Effect<void, MemoryStorageError | MemoryStoreConflict>;
  readonly readLocalSummaryPayload: (
    environmentId: M.EnvironmentId,
    intentId: string,
  ) => Effect.Effect<M.MemoryPayload | undefined, MemoryStorageError>;
  readonly refreshLocalSummaryIntent: (
    intent: LocalMemoryIntent,
  ) => Effect.Effect<void, MemoryStorageError | MemoryStoreConflict>;
  readonly materializeLocalIntent: (
    input: IntentIdentityInput,
  ) => Effect.Effect<MaterializedIntent, MemoryStorageError | MemoryStoreConflict>;
  readonly materializeLocalIntentTx: (input: IntentIdentityInput) => InTx<MaterializedIntent>;
  readonly completeLocalIntentTx: (input: {
    environmentId: M.EnvironmentId;
    intentId: string;
    materialized: MaterializedIntent;
    now: number;
  }) => InTx<void>;
  readonly installCheckpointPage: (
    input: CheckpointStageIdentity & {
      readonly page: M.MemoryHubCheckpointPage;
    },
  ) => Effect.Effect<void, MemoryStorageError | MemoryStoreConflict>;
  readonly completeCheckpoint: (
    input: CheckpointStageIdentity & {
      readonly pageCount: number;
      readonly localEnvironmentId?: M.EnvironmentId;
    },
  ) => Effect.Effect<void, MemoryStorageError | MemoryStoreConflict>;
  readonly readDueClaimCandidates: (
    limit: number,
    now: number,
    memorySpaceId: M.MemorySpaceId,
  ) => Effect.Effect<ReadonlyArray<MemoryWork>, MemoryStorageError>;
  readonly findClaimCandidate: (input: {
    memorySpaceId: M.MemorySpaceId;
    candidateId?: string;
    attemptId: M.MemoryOperationId;
  }) => Effect.Effect<MemoryWork | null, MemoryStorageError>;
  readonly recoverClaimCandidates: (now: number) => Effect.Effect<void, MemoryStorageError>;
  readonly claimCandidate: (
    id: string,
    epoch: number,
    now: number,
  ) => Effect.Effect<boolean, MemoryStorageError>;
  readonly retryClaimCandidate: (
    id: string,
    nextAttemptAt: number,
    failureCode: M.MemoryFailureCode,
    leaseExpiresAt?: number,
  ) => Effect.Effect<void, MemoryStorageError>;
  readonly completeClaimCandidate: (id: string) => Effect.Effect<void, MemoryStorageError>;
  readonly persistResolutionTicket: (
    ticket: M.MemoryResolutionLease,
  ) => Effect.Effect<void, MemoryStorageError>;
  readonly readReportTarget: (reportId: string) => Effect.Effect<
    {
      memorySpaceId: M.MemorySpaceId;
      memoryId: M.MemoryId;
      deliveryEnvironmentId: M.EnvironmentId;
    } | null,
    MemoryStorageError
  >;
  readonly nextReportWakeAt: (
    now: number,
    owner: M.EnvironmentId,
  ) => Effect.Effect<number | null, MemoryStorageError>;
  readonly acquireReports: (input: {
    owner: M.EnvironmentId;
    now: number;
    until: number;
    limit: number;
  }) => Effect.Effect<ReadonlyArray<M.MemoryReportDelivery>, MemoryStorageError>;
  readonly acknowledgeClaimedReport: (input: {
    delivery: M.MemoryReportDelivery;
    owner: M.EnvironmentId;
    claimUntil: number;
  }) => Effect.Effect<boolean, MemoryStorageError | MemoryStoreConflict | MemoryCapacityError>;
  readonly deferClaimedReport: (input: {
    reportId: string;
    owner: M.EnvironmentId;
    claimUntil: number;
    failureCode: M.MemoryFailureCode;
    nextAttemptAt: number;
  }) => Effect.Effect<boolean, MemoryStorageError>;
  readonly normalizeExpiredReports: (
    now: number,
    owner?: M.EnvironmentId,
  ) => Effect.Effect<void, MemoryStorageError>;
  readonly resetReportAttemptsTx: (
    input: M.MemoryResetReportAttemptsInput,
    now: number,
  ) => InTx<M.MemoryResetReportAttemptsResult>;
  readonly purgeDeliveredReportDetailsTx: (input: {
    memorySpaceId?: M.MemorySpaceId;
    environmentId?: M.EnvironmentId;
    now: number;
    limit: number;
  }) => InTx<{ removedRows: number; reclaimedLogicalBytes: number }>;
  readonly nextReportMaintenanceAt: (
    owner: M.EnvironmentId,
  ) => Effect.Effect<number | null, MemoryStorageError>;
  readonly pendingReports: (
    limit: number,
  ) => Effect.Effect<ReadonlyArray<M.MemoryReportDelivery>, MemoryStorageError>;
  readonly claimReport: (
    id: string,
    owner: string,
    now: number,
    until: number,
  ) => Effect.Effect<boolean, MemoryStorageError>;
  readonly acknowledgeReport: (
    input: M.MemoryReportDelivery,
  ) => Effect.Effect<void, MemoryStorageError | MemoryStoreConflict>;
  /** Failure intent and retry/termination share one ownership-fenced transaction. */
  readonly failGenerationAttempt: (input: {
    readonly work: MemoryWork;
    readonly environmentId: M.EnvironmentId;
    readonly failureCode: M.MemoryFailureCode;
    readonly now: number;
    readonly retryAt: number | null;
  }) => Effect.Effect<boolean, MemoryStorageError | MemoryStoreConflict>;
  readonly failReport: (
    id: string,
    failure: M.MemoryFailureCode,
  ) => Effect.Effect<void, MemoryStorageError>;
}
