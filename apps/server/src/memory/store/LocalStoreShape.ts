import type * as M from "@goat/contracts";
import type { MemoryRevertSlot } from "../MemoryRevertSlot.ts";
import type { ImportStorePorts } from "../imports/MemoryImportTypes.ts";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";
import type {
  MemoryCapacityError,
  MemoryStorageError,
  MemoryStoreConflict,
  MemoryWork,
  PendingForgetIntent,
  StoredReceipt,
  Transaction,
} from "./StoreModel.ts";
import type {
  InTx,
  MemoryAdmissionContext,
  MemoryAggregate,
  MemoryAncestry,
  MemoryDecision,
  MemoryDeferredWork,
  MemoryFtsState,
  MemoryHistorySelection,
  MemoryIndexTarget,
  MemoryPayloadSelection,
  MemoryQuotaCharge,
  MemoryReadFilter,
  MemoryUsage,
  ResolutionSnapshot,
  SyncWorkCandidate,
  ThreadLineage,
} from "./StoreModel.ts";

export interface LocalStoreShape {
  readonly transact: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    options?: { requireOuter?: boolean; finalGuard?: Effect.Effect<void, E> },
  ) => Effect.Effect<A, E | MemoryStorageError, Exclude<R, Transaction>>;
  readonly readThreadLineage: (
    thread: M.ScopedThreadRef,
    space: M.MemorySpaceId,
  ) => Effect.Effect<ThreadLineage, MemoryStorageError>;
  readonly appendThreadLineage: (
    thread: M.ScopedThreadRef,
    space: M.MemorySpaceId,
    revisions: ReadonlyArray<M.MemoryRevisionId>,
  ) => Effect.Effect<boolean, MemoryStorageError>;
  readonly deleteThreadLineage: (
    thread: M.ScopedThreadRef,
  ) => Effect.Effect<void, MemoryStorageError>;
  readonly receipt: (
    space: M.MemorySpaceId,
    id: M.MemoryOperationId,
  ) => Effect.Effect<StoredReceipt | undefined, MemoryStorageError>;
  readonly readResolutionInputsPage: (
    input: M.MemoryHistoryInput & { resolutionInputsFor: M.MemoryResolutionId },
  ) => Effect.Effect<
    { scope: M.MemoryScope | null; page: M.MemoryHistoryPage },
    MemoryStorageError | MemoryStoreConflict
  >;
  readonly readResolutionSnapshot: (
    space: M.MemorySpaceId,
    memoryId: M.MemoryId,
  ) => Effect.Effect<ResolutionSnapshot, MemoryStorageError>;
  readonly readResolutionHeads: (input: {
    memorySpaceId: M.MemorySpaceId;
    memoryId: M.MemoryId;
    heads: readonly M.MemoryRevisionId[];
    expectedGeneration: number;
    maxItems: number;
    maxBytes: number;
  }) => Effect.Effect<MemoryAggregate["revisions"], MemoryStorageError | MemoryStoreConflict>;
  readonly readAccess: (
    space: M.MemorySpaceId,
    id: M.MemoryId,
  ) => Effect.Effect<
    {
      item: M.MemoryItem | undefined;
      identity: M.MemoryIdentityRecord | undefined;
    },
    MemoryStorageError
  >;
  readonly historyPage: (
    input: M.MemoryHistoryInput,
    item: M.MemoryItem,
    owner: M.EnvironmentId,
  ) => Effect.Effect<
    {
      page: M.MemoryHistoryPage;
      consumed: MemoryAggregate["revisions"];
    },
    MemoryStorageError | MemoryStoreConflict
  >;
  readonly recordRevertResultTx: (input: {
    space: M.MemorySpaceId;
    memoryId: M.MemoryId;
    resolutionId: M.MemoryResolutionId;
    operationId: M.MemoryOperationId;
    slot: MemoryRevertSlot;
    settlement?: boolean;
  }) => InTx<void>;
  readonly loadAggregate: (
    space: M.MemorySpaceId,
    id: M.MemoryId,
    payloads?: MemoryPayloadSelection,
    history?: MemoryHistorySelection,
  ) => Effect.Effect<MemoryAggregate, MemoryStorageError>;
  readonly apply: (
    decision: MemoryDecision,
  ) => Effect.Effect<StoredReceipt, MemoryStorageError | MemoryStoreConflict | MemoryCapacityError>;
  readonly readAncestry: (
    space: M.MemorySpaceId,
    memoryId: M.MemoryId,
    parents: ReadonlyArray<M.MemoryRevisionId>,
  ) => Effect.Effect<MemoryAncestry, MemoryStorageError>;
  /** Recompute under transact; expectedGeneration fences the projection used by the decider. */
  readonly reconnectParked: (
    decision: MemoryDecision,
    expectedGeneration: number,
  ) => Effect.Effect<StoredReceipt, MemoryStorageError | MemoryStoreConflict | MemoryCapacityError>;
  readonly withReceivedCursor: <A, E, R>(
    input: {
      readonly memorySpaceId: M.MemorySpaceId;
      readonly hubEnvironmentId: M.EnvironmentId;
      readonly afterSequence: number;
      readonly expectedSequence: number;
    },
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | MemoryStorageError | MemoryStoreConflict, Exclude<R, Transaction>>;
  readonly readOperation: (
    space: M.MemorySpaceId,
    id: M.MemoryOperationId,
  ) => Effect.Effect<M.MemoryOperation | undefined, MemoryStorageError>;
  readonly readWorkOperation: (
    id: string,
  ) => Effect.Effect<M.MemoryOperation | undefined, MemoryStorageError>;
  readonly readCursor: (
    space: M.MemorySpaceId,
    hub: M.EnvironmentId,
  ) => Effect.Effect<number, MemoryStorageError>;
  readonly list: (
    filter: MemoryReadFilter,
  ) => Effect.Effect<ReadonlyArray<M.MemoryItem>, MemoryStorageError | MemoryStoreConflict>;
  readonly searchCoverage: (
    filter: MemoryReadFilter,
  ) => Effect.Effect<
    { ready: boolean; eligible: number; indexed: number; textBytes: number },
    MemoryStorageError
  >;
  readonly search: (
    filter: MemoryReadFilter,
    text: string,
    mode: "fts" | "substring",
  ) => Effect.Effect<
    M.MemorySearchPage,
    MemoryStorageError | MemoryStoreConflict | MemoryCapacityError
  >;
  readonly dueWork: (
    now: number,
    limit: number,
    kinds?: ReadonlyArray<"summary" | "consolidate" | "rebuild">,
  ) => Effect.Effect<ReadonlyArray<MemoryWork>, MemoryStorageError>;
  readonly readWork: (id: string) => Effect.Effect<MemoryWork | undefined, MemoryStorageError>;
  /** Snapshot ownership prevents a timed-out worker from postponing a newer claim. */
  readonly retryWork: (
    work: MemoryWork,
    nextAttemptAt: number,
  ) => Effect.Effect<boolean, MemoryStorageError>;
  /** Extends a live claim held by the same owner and attempt; undefined once it lapsed or moved. */
  readonly renewWork: (
    work: MemoryWork,
    now: number,
    until: number,
  ) => Effect.Effect<MemoryWork | undefined, MemoryStorageError>;
  /**
   * Moves a live summary claim to another model before generation. Undefined once the
   * claim lapsed or moved; ids and space are kept so receipts stay idempotent.
   */
  readonly rebindWorkModel: (
    work: MemoryWork,
    modelSelection: M.MemoryModelSelection,
  ) => Effect.Effect<MemoryWork | undefined, MemoryStorageError>;
  readonly cancelThreadWork: (
    thread: M.ScopedThreadRef,
  ) => Effect.Effect<number, MemoryStorageError>;
  readonly readThreadHookWatermark: () => Effect.Effect<number, MemoryStorageError>;
  readonly commitThreadHook: (input: {
    readonly expectedWatermark: number;
    readonly throughWatermark: number;
    readonly work: ReadonlyArray<MemoryWork>;
  }) => Effect.Effect<void, MemoryStorageError | MemoryStoreConflict>;
  readonly enqueueWork: (work: MemoryWork) => Effect.Effect<void, MemoryStorageError>;
  /** Makes summary and consolidation retries due now, after the model they waited on changed. */
  readonly rearmGenerationWork: (now: number) => Effect.Effect<number, MemoryStorageError>;
  readonly claimWork: (
    id: string,
    owner: string,
    now: number,
    until: number,
  ) => Effect.Effect<boolean, MemoryStorageError>;
  readonly finishWork: (
    id: string,
    status: "completed" | "cancelled" | "failed",
    receipt?: M.MemoryHubReceipt,
  ) => Effect.Effect<void, MemoryStorageError>;
  readonly readEligibleOutbox: (
    space: M.MemorySpaceId,
    now: number,
    limit: number,
  ) => Effect.Effect<readonly SyncWorkCandidate[], MemoryStorageError>;
  readonly acknowledgeOutbox: (
    id: string,
    receipt: M.MemoryHubReceipt,
  ) => Effect.Effect<void, MemoryStorageError | MemoryStoreConflict>;
  readonly enqueuePendingForget: (input: {
    readonly operation: Extract<M.MemoryOperation, { kind: "forget" }>;
    readonly operationDigest: string;
  }) => Effect.Effect<void, MemoryStorageError | MemoryStoreConflict>;
  readonly preserveForgetIntent: (
    intent: PendingForgetIntent,
  ) => Effect.Effect<void, MemoryStorageError | MemoryCapacityError>;
  readonly pendingForgetIntents: (
    limit: number,
  ) => Effect.Effect<ReadonlyArray<PendingForgetIntent>, MemoryStorageError>;
  readonly settleForgetIntent: (
    space: M.MemorySpaceId,
    id: M.MemoryId,
  ) => Effect.Effect<void, MemoryStorageError | MemoryStoreConflict>;
  readonly readDeferred: (
    now: number,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<MemoryDeferredWork>, MemoryStorageError>;
  readonly readScannerChunk: (target: MemoryDeferredWork) => Effect.Effect<
    {
      readonly payloads: ReadonlyArray<M.MemoryPayload | M.MemoryResolutionPayload>;
      readonly nextCursor: string | null;
    },
    MemoryStorageError
  >;
  readonly claimDeferred: (
    target: MemoryDeferredWork,
    owner: string,
    now: number,
    until: number,
  ) => Effect.Effect<boolean, MemoryStorageError>;
  readonly recoverDeferred: (
    scannerPolicyVersion: number,
    now: number,
  ) => Effect.Effect<void, MemoryStorageError>;
  readonly finishOwnedDeferred: (
    target: MemoryDeferredWork,
    owner: string,
    until: number,
    outcome: {
      readonly now: number;
      readonly failure?: M.MemoryDeferredReason;
      readonly scannerPolicyVersion?: number;
      readonly scannerCursor?: string;
      readonly ruleIds?: ReadonlyArray<string>;
    },
  ) => Effect.Effect<boolean, MemoryStorageError>;
  readonly completeSummaryWork: (work: MemoryWork) => Effect.Effect<boolean, MemoryStorageError>;
  readonly finishDeferred: (
    target: MemoryDeferredWork,
    outcome: {
      readonly now: number;
      readonly failure?: M.MemoryDeferredReason;
      readonly scannerPolicyVersion?: number;
      readonly scannerCursor?: string;
      readonly ruleIds?: ReadonlyArray<string>;
    },
  ) => Effect.Effect<boolean, MemoryStorageError>;
  readonly getProjectBinding: (
    space: M.MemorySpaceId,
    project: M.ScopedProjectRef,
  ) => Effect.Effect<M.MemoryProjectBinding | undefined, MemoryStorageError>;
  readonly putProjectBinding: (
    binding: M.MemoryProjectBinding,
    expectedVersion: number | null,
    now: number,
  ) => Effect.Effect<void, MemoryStorageError | MemoryStoreConflict>;
  readonly changes: (
    space: M.MemorySpaceId,
  ) => Effect.Effect<
    Stream.Stream<M.MemoryChangeSignal, MemoryStorageError>,
    MemoryStorageError,
    Scope.Scope
  >;
  readonly persistCompactReceipt: (
    record: M.MemoryCompactReceipt,
  ) => Effect.Effect<void, MemoryStorageError | MemoryStoreConflict>;
  readonly operationMetadataBytes: (
    operation: M.MemoryOperation,
  ) => Effect.Effect<number, MemoryStorageError>;
  readonly settleForgetExpansion: (
    space: M.MemorySpaceId,
    result: StoredReceipt,
  ) => Effect.Effect<StoredReceipt, MemoryStorageError | MemoryStoreConflict>;
  readonly firstForgetReservation: (
    operation: M.MemoryOperation,
  ) => Effect.Effect<{ bytes: number; keys: number }, MemoryStorageError>;
  readonly readForgetReservation: (
    space: M.MemorySpaceId,
    id: M.MemoryId,
  ) => Effect.Effect<{ bytes: number; keys: number }, MemoryStorageError>;
  readonly usage: (
    space: M.MemorySpaceId,
    scope: M.MemoryScope,
  ) => Effect.Effect<MemoryUsage, MemoryStorageError>;
  readonly readImportRegistrationTx: ImportStorePorts["readImportRegistrationTx"];
  readonly writeImportRegistrationTx: ImportStorePorts["writeImportRegistrationTx"];
  readonly readImportBatchTx: ImportStorePorts["readImportBatchTx"];
  readonly readImportReceiptTx: ImportStorePorts["readImportReceiptTx"];
  readonly readImportItemTx: ImportStorePorts["readImportItemTx"];
  readonly commitImportItemTx: ImportStorePorts["commitImportItemTx"];
  readonly findImportMatchTx: ImportStorePorts["findImportMatchTx"];
  readonly requireImportLineageCompleteTx: (
    space: M.MemorySpaceId,
  ) => InTx<void, MemoryStorageError | MemoryStoreConflict>;
  readonly readImportLineage: (
    space: M.MemorySpaceId,
    id: M.MemoryId,
  ) => Effect.Effect<ReadonlyArray<M.MemoryImportLineageRecord>, MemoryStorageError>;
  readonly unionImportLineageTx: (
    records: ReadonlyArray<M.MemoryImportLineageRecord>,
    admission: MemoryAdmissionContext,
  ) => InTx<void, MemoryStorageError | MemoryStoreConflict | MemoryCapacityError>;
  readonly readSuppressions: (
    space: M.MemorySpaceId,
    id: M.MemoryId,
  ) => Effect.Effect<ReadonlyArray<M.MemorySuppressionRecord>, MemoryStorageError>;
  readonly logicalBytes: Effect.Effect<number, MemoryStorageError>;
  readonly reserve: (
    context: MemoryAdmissionContext,
    charges: ReadonlyArray<MemoryQuotaCharge>,
  ) => Effect.Effect<void, MemoryStorageError | MemoryCapacityError>;
  readonly counters: (space: string) => Effect.Effect<
    ReadonlyArray<{
      readonly dimension: string;
      readonly scope_key: string;
      readonly value: number;
    }>,
    MemoryStorageError
  >;
  readonly ftsState: (
    environment: M.EnvironmentId,
  ) => Effect.Effect<MemoryFtsState, MemoryStorageError>;
  readonly putFtsState: (state: MemoryFtsState) => Effect.Effect<void, MemoryStorageError>;
  readonly index: (
    target: MemoryIndexTarget,
  ) => Effect.Effect<boolean, MemoryStorageError | MemoryCapacityError>;
  readonly measureAllocation: () => Effect.Effect<
    {
      readonly memoryBytes: number | null;
      readonly ftsBytes: number | null;
      readonly dbFileBytes: number;
      readonly freelistBytes: number;
      readonly tables: ReadonlyArray<M.MemoryStorageTableUsage>;
    },
    MemoryStorageError
  >;
  /** Memory btree bytes from the current storage sample, or null before the first one. */
  readonly measuredMemoryBytes: (
    environment: M.EnvironmentId,
  ) => Effect.Effect<number | null, MemoryStorageError>;
  /**
   * Deletes summary work rows that no scan or summary can read again, among the pageRows
   * outbox rows after afterRowId. nextRowId is null once the page reached the end.
   */
  readonly pruneSettledSummaryWork: (
    environment: M.EnvironmentId,
    afterRowId: number,
    pageRows: number,
  ) => Effect.Effect<
    { readonly removed: number; readonly nextRowId: number | null },
    MemoryStorageError
  >;
  readonly mergeFts: () => Effect.Effect<boolean, MemoryStorageError>;
  readonly recordSample: (
    environment: M.EnvironmentId,
    sample: M.MemoryStorageSample,
  ) => Effect.Effect<boolean, MemoryStorageError>;
  readonly samples: (
    environment: M.EnvironmentId,
  ) => Effect.Effect<ReadonlyArray<M.MemoryStorageSample>, MemoryStorageError>;
  readonly wake: Effect.Effect<void>;
  readonly subscribeWake: Effect.Effect<Stream.Stream<void>, never, Scope.Scope>;
}
