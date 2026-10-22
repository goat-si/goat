import { MemoryHubSettingsSnapshot } from "../MemoryHubSettings.ts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- stable server-owned hashes.
import * as NodeCrypto from "node:crypto";
import * as M from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class MemoryStorageError extends Schema.TaggedError<MemoryStorageError>()(
  "MemoryStorageError",
  {
    stage: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return "Memory storage failed.";
  }
}
export class MemoryStoreConflict extends Schema.TaggedError<MemoryStoreConflict>()(
  "MemoryStoreConflict",
  {
    code: M.MemoryFailureCode,
  },
) {
  override get message() {
    return "Memory storage state changed.";
  }
}
export type CheckpointStageIdentity = {
  readonly memorySpaceId: M.MemorySpaceId;
  readonly hubEnvironmentId: M.EnvironmentId;
  readonly checkpointId: string;
  readonly expectedSnapshotToken: string;
  readonly expectedCheckpointSequence: number;
};

export class MemoryCapacityError extends Schema.TaggedError<MemoryCapacityError>()(
  "MemoryCapacityError",
  {
    dimension: Schema.String,
    limit: Schema.Int,
    current: Schema.optionalKey(Schema.Int),
    reclaimable: Schema.optionalKey(Schema.Int),
  },
) {
  override get message() {
    return "Memory capacity exceeded.";
  }
}

// These contexts are constructed inside the server, never decoded from a transport.
const admissionBrand: unique symbol = Symbol("memory-admission");
export type MemoryAdmissionContext = {
  /** Local final CAS only; the v1 wire operation keeps expectedHeads equal to revision parents. */
  readonly localExpectedHeads?: readonly M.MemoryRevisionId[];
  readonly [admissionBrand]: true;
  readonly kind: "localIntent" | "hubAdmission" | "approvedReplica";
};
export const localIntent: MemoryAdmissionContext = { [admissionBrand]: true, kind: "localIntent" };
export const hubAdmission: MemoryAdmissionContext = {
  [admissionBrand]: true,
  kind: "hubAdmission",
};
export const approvedReplica: MemoryAdmissionContext = {
  [admissionBrand]: true,
  kind: "approvedReplica",
};

export const sameHeadSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id) => b.includes(id));
export const hashText = (text: string) =>
  NodeCrypto.createHash("sha256").update(text).digest("hex");
export const strict = { onExcessProperty: "error" } as const;
export const digest = Schema.String.check(Schema.makeFilter((s) => /^[a-f0-9]{64}$/.test(s)));
export const Metadata = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  operationId: M.MemoryOperationId,
  memorySpaceId: M.MemorySpaceId,
  memoryId: M.MemoryId,
  originEnvironmentId: M.EnvironmentId,
  kind: Schema.Literals(["upsert", "forget", "resolve", "revert"]),
  expectedHeads: Schema.Array(M.MemoryRevisionId),
  revision: Schema.optionalKey(M.MemoryRevision),
  tombstone: Schema.optionalKey(M.MemoryTombstone),
  resolution: Schema.optionalKey(M.MemoryResolution),
  conflictId: Schema.optionalKey(M.MemoryConflictId),
  fencingToken: Schema.optionalKey(Schema.Int),
  revertsResolutionId: Schema.optionalKey(M.MemoryResolutionId),
  restoredRevisionId: Schema.optionalKey(M.MemoryRevisionId),
});
export const Receipt = Schema.Union([M.MemoryHubReceipt, M.MemoryMutationReceipt]);
export const StoredReceipt = Schema.Struct({
  operationDigest: digest,
  receipt: Receipt,
});
export type StoredReceipt = typeof StoredReceipt.Type;
export const LocalMemoryIntent = Schema.Struct({
  intentId: Schema.String,
  memoryId: M.MemoryId,
  environmentId: M.EnvironmentId,
  scope: M.MemoryScope,
  provenance: M.MemoryProvenance,
  assertionKind: M.MemoryAssertionKind,
  createdAtUtc: M.MemoryUtcTimestamp,
  payload: M.MemoryPayload,
});
export type LocalMemoryIntent = typeof LocalMemoryIntent.Type;
export const LocalIntentMetadata = Schema.Struct({
  kind: Schema.Literal("localIntent"),
  intentId: Schema.String,
  memoryId: M.MemoryId,
  environmentId: M.EnvironmentId,
  scope: M.MemoryScope,
  provenance: M.MemoryProvenance,
  assertionKind: M.MemoryAssertionKind,
  createdAtUtc: M.MemoryUtcTimestamp,
  mapping: Schema.NullOr(
    Schema.Struct({
      memorySpaceId: M.MemorySpaceId,
      operationId: M.MemoryOperationId,
      revisionId: M.MemoryRevisionId,
    }),
  ),
});
export const threadHookId = "memory:thread-hook:v1";
export const ThreadHookMetadata = Schema.Struct({
  kind: Schema.Literal("threadHook"),
  watermark: Schema.Int.check(Schema.makeFilter((n) => n >= 0)),
});
// One body-free cumulative set per native context owner, never one receipt per run.
export const ThreadLineageMetadata = Schema.Struct({
  kind: Schema.Literal("threadLineage"),
  sourceThread: M.ScopedThreadRef,
  memorySpaceId: M.MemorySpaceId,
  state: Schema.Literals(["tracked", "unknown", "overflow"]),
  revisions: Schema.Array(M.MemoryRevisionId).check(Schema.isMaxLength(100)),
});
export type ThreadLineage = typeof ThreadLineageMetadata.Type;
export const threadLineageId = (thread: M.ScopedThreadRef) =>
  `memory:thread-lineage:${JSON.stringify([thread.environmentId, thread.threadId])}`;
export const WorkMetadata = Schema.Union([
  ThreadLineageMetadata,
  ThreadHookMetadata,
  Metadata,
  LocalIntentMetadata,
  Schema.Struct({
    kind: Schema.Literal("summary"),
    sourceThread: M.ScopedThreadRef,
    sourceWatermark: M.MemorySourceWatermark,
    completedAt: Schema.optionalKey(Schema.Int),
    fromSequence: Schema.optionalKey(Schema.Int),
    observedThroughSequence: Schema.optionalKey(Schema.Int),
    memoryId: M.MemoryId,
    operationId: M.MemoryOperationId,
    revisionId: M.MemoryRevisionId,
    modelSelection: M.MemoryModelSelection,
  }),
  Schema.Struct({
    kind: Schema.Literal("claim"),
    generation: Schema.optionalKey(Schema.Int),
    conflictId: M.MemoryConflictId,
    sortedHeads: Schema.Array(M.MemoryRevisionId),
    headSetDigest: digest,
    attemptId: Schema.optionalKey(M.MemoryOperationId),
    leaseExpiresAt: Schema.optionalKey(Schema.Int),
    coordinatorEpoch: Schema.optionalKey(Schema.Int),
  }),
  Schema.Struct({ kind: Schema.Literal("resolve"), ticket: M.MemoryResolutionLease }),
  Schema.Struct({
    kind: Schema.Literal("binding"),
    requestDigest: digest,
    result: M.MemoryProjectBindingUpdateResult,
  }),
  Schema.Struct({
    kind: Schema.Literal("rebuild"),
    revisionId: Schema.NullOr(M.MemoryRevisionId),
    generation: Schema.Int,
  }),
]);
export const MemoryWork = Schema.Struct({
  id: Schema.String,
  space: Schema.String,
  memoryId: Schema.NullOr(M.MemoryId),
  kind: Schema.Literals([
    "sync",
    "revert_intent",
    "summary",
    "consolidate",
    "claim",
    "resolve",
    "rebuild",
    "admin",
  ]),
  status: Schema.Literals(["pending", "running", "retry", "completed", "cancelled", "failed"]),
  metadata: WorkMetadata,
  payloadRef: Schema.NullOr(Schema.String),
  attempt: Schema.Int,
  nextAttemptAt: Schema.Int,
  claimedBy: Schema.NullOr(Schema.String),
  claimedUntil: Schema.NullOr(Schema.Int),
});
// Cursor follows inspected rows, including unrelated or protected work. `more` is conservative:
// a full page may require one empty final page. No lookahead exceeds the inspection budget.
export type HoldRearmPage = {
  readonly changedIds: readonly string[];
  readonly inspected: number;
  readonly next: string | null;
  readonly more: boolean;
};

export type MemoryWork = typeof MemoryWork.Type;
export const DeferredRow = Schema.Struct({
  scannerCursor: Schema.optionalKey(Schema.String),
  kind: Schema.Literals(["index", "scanner", "parent", "projection", "cleanup", "report"]),
  state: Schema.Literals(["pending", "held", "ready"]),
  reason: Schema.NullOr(M.MemoryDeferredReason),
  revisionId: Schema.NullOr(M.MemoryRevisionId),
  generation: Schema.Int,
  sinceAtUtc: Schema.NullOr(M.MemoryUtcTimestamp),
  attempt: Schema.Int,
  dueAt: Schema.Int,
  lastAttemptAt: Schema.NullOr(Schema.Int),
  claimedBy: Schema.NullOr(Schema.String),
  claimedUntil: Schema.NullOr(Schema.Int),
});
export type MemoryDeferredWork = typeof DeferredRow.Type & {
  readonly memorySpaceId: M.MemorySpaceId;
  readonly memoryId: M.MemoryId;
  readonly payloadBytes: number;
};
export const PendingForgetIntent = Schema.Struct({
  memorySpaceId: M.MemorySpaceId,
  memoryId: M.MemoryId,
  operationId: M.MemoryOperationId,
  requestedAtUtc: M.MemoryUtcTimestamp,
  attempts: Schema.Int,
  lastFailureCode: Schema.NullOr(M.MemoryFailureCode),
  operationDigest: Schema.NullOr(digest),
  submissionState: Schema.Literals(["unsubmitted", "uncertain", "rejected"]),
});
export type PendingForgetIntent = typeof PendingForgetIntent.Type;
export type ResolutionSnapshot = {
  readonly memorySpaceId: M.MemorySpaceId;
  readonly memoryId: M.MemoryId;
  readonly status: M.MemoryItem["status"] | null;
  readonly heads: readonly M.MemoryRevisionId[];
  readonly generation: number;
  readonly reasons: M.MemoryLocalAvailability["reasons"];
  readonly tombstone: boolean;
  readonly pendingForget: boolean;
  readonly fence: M.MemoryFenceRecord | undefined;
};
export type MemoryAggregate = {
  readonly memorySpaceId: M.MemorySpaceId;
  readonly memoryId: M.MemoryId;
  readonly item: M.MemoryItem | undefined;
  readonly heads: ReadonlyArray<M.MemoryRevisionId>;
  readonly revisions: ReadonlyArray<{
    readonly revision: M.MemoryRevision;
    readonly payload: M.MemoryPayload | null;
  }>;
  readonly tombstone: M.MemoryTombstone | undefined;
  readonly conflicts: ReadonlyArray<M.MemoryConflict>;
  readonly resolutions: ReadonlyArray<M.MemoryResolution>;
  readonly identity: M.MemoryIdentityRecord | undefined;
  readonly fence: M.MemoryFenceRecord | undefined;
  readonly pendingForget: PendingForgetIntent | undefined;
  readonly generation: number;
};
/**
 * Narrows which revision payloads `loadAggregate` reads and decodes. The revision DAG is
 * always complete; payloads outside the selection read as `null`, so pass one only when the
 * caller never reads those payloads. Omit it to decode every payload.
 */
export type MemoryPayloadSelection = {
  /** Current heads, which admission uses for the live payload. */
  readonly heads?: boolean;
  readonly revisionIds?: ReadonlyArray<M.MemoryRevisionId>;
  readonly when?: (revision: M.MemoryRevision) => boolean;
};
/**
 * Admission needs at most the claimed conflict, the reverted resolution, and the incoming
 * revision's frontier/parent metadata. Omit this selection for full history; `{}` skips
 * historical rows that are not explicitly selected.
 */
export type MemoryHistorySelection = {
  readonly conflictId?: M.MemoryConflictId;
  readonly resolutionId?: M.MemoryResolutionId;
  /** Incoming revision whose admission DAG checks need its direct parents and any active ancestry. */
  readonly revision?: M.MemoryRevision;
  readonly metadataRevisionIds?: ReadonlyArray<M.MemoryRevisionId>;
  /** Also retain import-attributed revision metadata when computing forget reservations. */
  readonly importLineage?: boolean;
};
/** A published boundary is not proof that an arbitrary unknown UUID was compacted. */
export type MemoryParentState =
  | {
      readonly revisionId: M.MemoryRevisionId;
      readonly status: "retained";
      readonly parents: ReadonlyArray<M.MemoryRevisionId>;
    }
  | {
      readonly revisionId: M.MemoryRevisionId;
      readonly status: "crossMemory";
      readonly memoryId: M.MemoryId;
    }
  | {
      readonly revisionId: M.MemoryRevisionId;
      readonly status: "compacted";
      readonly boundary: M.MemoryCausalBoundary;
    }
  | {
      readonly revisionId: M.MemoryRevisionId;
      readonly status: "parked";
      readonly missingParents: ReadonlyArray<M.MemoryRevisionId>;
    }
  | { readonly revisionId: M.MemoryRevisionId; readonly status: "missing" };
export type MemoryAncestry = {
  readonly causalBoundary: M.MemoryCausalBoundary | undefined;
  readonly retentionFloor: number;
  readonly parents: ReadonlyArray<MemoryParentState>;
};
/** Only these revisions contribute payload evidence to forget reservations and exclusions. */
export const hasSourceEvidence = (revision: M.MemoryRevision) =>
  Boolean(revision.provenance.sourceThread && revision.provenance.sourceWatermark);
/** Expanded wire exclusions are stored and admitted per message. */
export const memorySuppressionRecords = (t: M.MemoryTombstone): M.MemorySuppressionRecord[] => [
  ...t.suppressedSourceKeys.map((sourceKey) => ({
    memorySpaceId: t.memorySpaceId,
    memoryId: t.memoryId,
    deleteOperationId: t.deleteOperationId,
    kind: "sourceKey" as const,
    sourceKey,
  })),
  ...t.suppressedContent.map((content) => ({
    memorySpaceId: t.memorySpaceId,
    memoryId: t.memoryId,
    deleteOperationId: t.deleteOperationId,
    kind: "content" as const,
    content,
  })),
  ...t.sourceExclusions.flatMap((exclusion) =>
    exclusion.messageIds.map((messageId) => ({
      memorySpaceId: t.memorySpaceId,
      memoryId: t.memoryId,
      deleteOperationId: t.deleteOperationId,
      kind: "sourceExclusion" as const,
      exclusion: { ...exclusion, messageIds: [messageId] },
    })),
  ),
];
export type MemoryDecision = {
  readonly operation: M.MemoryOperation;
  readonly operationDigest: string;
  readonly admission: MemoryAdmissionContext;
  readonly receipt: M.MemoryHubReceipt | M.MemoryMutationReceipt;
  readonly item?: M.MemoryItem;
  readonly heads?: ReadonlyArray<M.MemoryRevisionId>;
  readonly conflict?: M.MemoryConflict;
  readonly identity?: M.MemoryIdentityRecord;
  readonly fence?: M.MemoryFenceRecord;
  readonly execution?: M.MemoryGenerationExecution;
  readonly work?: ReadonlyArray<MemoryWork>;
  readonly pending?: {
    readonly missingParents: ReadonlyArray<M.MemoryRevisionId>;
    readonly reason: M.MemoryDeferredReason;
  };
  readonly signals?: ReadonlyArray<M.MemoryChangeSignal>;
};
export type InTx<A, E = MemoryStorageError | MemoryStoreConflict> = Effect.Effect<
  A,
  E,
  Transaction
>;
export type HubMember = {
  memorySpaceId: M.MemorySpaceId;
  environmentId: M.EnvironmentId;
  credentialDigest: string;
  credentialVersion: number;
  status: "active" | "revoked";
  joinedAt: number | null;
};
export type HubAuthority = {
  principal: M.MemoryHubPrincipal;
  now: InTx<number, MemoryStorageError>;
  reauthorize: InTx<
    void,
    M.MemoryHubUnauthorizedError | M.MemoryHubForbiddenError | MemoryStorageError
  >;
};
export type HubLedgerRecord = { entry: M.MemoryHubEntry; committedAt: number };
export type Settlement = {
  receipt: M.MemoryHubReceipt;
  incorporated: boolean;
  intent: "none" | "completed" | "rejected" | "review";
};
export const HoldClass = Schema.Literals(["authorization", "protocol", "identity", "availability"]);
export type MemoryHoldClass = typeof HoldClass.Type;
export const PullRetry = Schema.Struct({
  version: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2147483647 })),
  attempts: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2147483647 })),
  nextAttemptAt: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  ),
  failureCode: Schema.NullOr(M.MemoryFailureCode),
  holdClass: Schema.NullOr(HoldClass),
});
export type PullRetryState = typeof PullRetry.Type;
export const emptyPullRetry: PullRetryState = {
  version: 0,
  attempts: 0,
  nextAttemptAt: 0,
  failureCode: null,
  holdClass: null,
};
export type WorkHold = {
  holdClass: MemoryHoldClass | null;
  failureCode: M.MemoryFailureCode | null;
};
export type SyncWorkCandidate = {
  work: MemoryWork;
  operationId: M.MemoryOperationId;
  operationDigest: string;
  version: number;
};
export type SyncWorkOwner = {
  workId: string;
  operationId: M.MemoryOperationId;
  operationDigest: string;
  owner: string;
  version: number;
  ownedUntil: number;
};
export type IntentIdentityInput = {
  environmentId: M.EnvironmentId;
  intentId: string;
  memorySpaceId: M.MemorySpaceId;
  operationId: M.MemoryOperationId;
  revisionId: M.MemoryRevisionId;
};
export type MaterializedIntent = {
  readonly operation: M.MemoryOperation;
  readonly operationDigest: string;
};
export type AssignedIntent = {
  intent: LocalMemoryIntent;
  memorySpaceId: M.MemorySpaceId;
  operationId: M.MemoryOperationId;
  revisionId: M.MemoryRevisionId;
};
export type TicketState =
  | "recoverable"
  | "running"
  | "submitting"
  | "approved"
  | "finalizing"
  | "terminal";
export const TicketRowSchema = Schema.Struct({
  ticket: M.MemoryResolutionLease,
  version: Schema.Int,
  state: Schema.Literals([
    "recoverable",
    "running",
    "submitting",
    "approved",
    "finalizing",
    "terminal",
  ]),
  owner: Schema.NullOr(Schema.String),
  coordinatorEpoch: Schema.Int,
  ownedUntil: Schema.NullOr(Schema.Int),
  nextAttemptAt: Schema.Int,
  submission: Schema.NullOr(M.MemoryHubApplyResolutionInput),
  submissionDigest: Schema.NullOr(digest),
  approval: Schema.NullOr(M.MemoryHubReceipt),
  reconcileRequired: Schema.optionalKey(Schema.Boolean),
});
// SQL stores only immutable submission metadata; bodies live in purgeable payload rows.
export const HubAttemptReplay = Schema.Struct({
  requestDigest: digest,
  claimedAt: Schema.Int,
  deadline: Schema.Int,
  fencingToken: Schema.Int,
});
export const StoredTicketRowSchema = Schema.Struct({
  ...TicketRowSchema.fields,
  submission: Schema.NullOr(
    Schema.Struct({
      protocolVersion: Schema.Literal(1),
      memorySpaceId: M.MemorySpaceId,
      holderEnvironmentId: M.EnvironmentId,
      attemptId: M.MemoryOperationId,
      operation: Metadata,
    }),
  ),
});
export type TicketRow = typeof TicketRowSchema.Type;
export type SubmissionReconciliation =
  | { readonly outcome: "admitted"; readonly row: TicketRow; readonly receipt: M.MemoryHubReceipt }
  | { readonly outcome: "retired"; readonly row: TicketRow }
  | { readonly outcome: "uncertain"; readonly row: TicketRow };
export type TicketKey = { memorySpaceId: M.MemorySpaceId; attemptId: M.MemoryOperationId };
export type TicketOwner = TicketKey & { owner: string; coordinatorEpoch: number; version: number };
/** Shared key for ACK, pull, checkpoint and local delivery. */
export const resolutionReportId = (
  space: M.MemorySpaceId,
  operation: M.MemoryOperationId,
  resolution: M.MemoryResolutionId,
): M.MemoryReportDelivery["reportId"] => hashText(`${space}:${operation}:${resolution}`);

const adminBase = {
  requestId: M.MemoryOperationId,
  expectedVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
};
export const PersistedAdminActionSchema = Schema.Union([
  Schema.Struct({
    ...adminBase,
    action: Schema.Literal("configure"),
    settings: M.MemoryHubSettings,
  }),
  Schema.Struct({
    ...adminBase,
    action: Schema.Literals(["provisionMember", "rotateMemberCredential", "revokeMember"]),
    environmentId: M.EnvironmentId,
  }),
  Schema.Struct({
    ...adminBase,
    action: Schema.Literal("installCredential"),
    hubEnvironmentId: M.EnvironmentId,
    endpoint: M.MemoryHubEndpoint,
    memorySpaceId: M.MemorySpaceId,
  }),
  Schema.Struct({
    ...adminBase,
    action: Schema.Literal("acknowledgeCredential"),
    credentialRequestId: M.MemoryOperationId,
  }),
]);
export type PersistedAdminAction =
  | Exclude<M.MemoryHubSettingsUpdateInput, { action: "installCredential" }>
  | Omit<Extract<M.MemoryHubSettingsUpdateInput, { action: "installCredential" }>, "credential">;
export const AdminRecordSchema = Schema.Struct({
  initialization: Schema.optionalKey(Schema.Literal("auto-initialized")),
  requestId: M.MemoryOperationId,
  requestDigest: digest,
  expectedVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  stage: Schema.Literals(["prepared", "activated", "ready", "acknowledged"]),
  action: PersistedAdminActionSchema,
  secretName: Schema.NullOr(
    Schema.String.check(Schema.makeFilter((v) => /^[a-z0-9-]{1,128}$/.test(v))),
  ),
  result: Schema.NullOr(Schema.Struct({ view: MemoryHubSettingsSnapshot })),
  memberVersion: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
}).check(
  Schema.makeFilter(
    (v) => v.requestId === v.action.requestId && v.expectedVersion === v.action.expectedVersion,
  ),
);
export type AdminRecord = typeof AdminRecordSchema.Type;
export const AdminReplaySchema = Schema.Struct({
  initialization: Schema.optionalKey(Schema.Literal("auto-initialized")),
  requestId: M.MemoryOperationId,
  requestDigest: digest,
  expectedVersion: Schema.Int,
  stage: Schema.Literal("acknowledged"),
  actionDigest: digest,
  secretName: AdminRecordSchema.fields.secretName,
  result: AdminRecordSchema.fields.result,
  memberVersion: AdminRecordSchema.fields.memberVersion,
});
export type AdminReplay = typeof AdminReplaySchema.Type;

export const HubCheckpointHandleSchema = Schema.Struct({
  checkpointId: Schema.String,
  snapshotToken: Schema.String,
  memorySpaceId: M.MemorySpaceId,
  hubEnvironmentId: M.EnvironmentId,
  memberEnvironmentId: M.EnvironmentId,
  credentialVersion: Schema.Int,
  checkpointSequence: Schema.Int,
  retentionFloor: Schema.Int,
  firstIssuedAt: Schema.Int,
  expiresAt: Schema.Int,
  pageCount: Schema.Int,
});
export type HubCheckpointHandle = typeof HubCheckpointHandleSchema.Type;
// A pin is transient; its first issue and retirement are permanent replay knowledge.
export const CheckpointTokenGuardSchema = Schema.Struct({
  handle: HubCheckpointHandleSchema,
  retired: Schema.Boolean,
});
export type HubRetention = {
  memorySpaceId: M.MemorySpaceId;
  checkpointId: string | null;
  checkpointSequence: number;
  retentionFloor: number;
  causalBoundary: M.MemoryCausalBoundary | null;
  compaction: M.MemoryCompactionStatus;
};
export type HubUsage = {
  tables: readonly M.MemoryStorageTableUsage[];
  tailRows: number;
  tailBytes: number;
  permanentMetadataBytes: number;
  activeMembers: number;
  liveHandles: number;
  stagingBytes: number;
  checkpointBytes: number;
  requiredCheckpointBoundBytes: number;
  lastSnapshotBytes: number;
  checkpointReservationConsumedBytes: number;
  publishedPinnedBytes: number;
  liveSourceReads: number;
  sourcePayloadBytes: number;
};
export type MemoryUsage = {
  readonly scopeItems: number;
  readonly scopeSummaries: number;
  readonly scopeExplicit: number;
  readonly environmentItems: number;
  readonly environmentLiveBytes: number;
  readonly environmentHistoryBytes: number;
  readonly environmentPermanentBytes: number;
  readonly environmentReceipts: number;
  readonly environmentLifetimeIds: number;
  readonly spaceItems: number;
  readonly lifetimeIds: number;
  readonly permanentBytes: number;
  readonly receipts: number;
  readonly liveBytes: number;
  readonly historyBytes: number;
  readonly logicalBytes: number;
  readonly keys: number;
  readonly workItems: number;
  readonly workBytes: number;
  readonly reportItems: number;
  readonly reportBytes: number;
  readonly logRows: number;
  readonly logBytes: number;
};
export type MemoryQuotaCharge = {
  readonly space: string;
  readonly dimension: string;
  readonly scopeKey: string;
  readonly delta: number;
  readonly current?: number;
  readonly limit: number;
};
export type MemoryReadFilter = {
  readonly memorySpaceId: M.MemorySpaceId;
  readonly scope: M.MemoryScope;
  readonly afterMemoryId?: M.MemoryId;
  readonly limit: number;
};
export const FtsState = Schema.Struct({
  environment: M.EnvironmentId,
  state: Schema.Literals(["open", "braked"]),
  changedAt: Schema.NullOr(Schema.Int),
  allocatedBytes: Schema.NullOr(Schema.Int),
  measuredAt: Schema.NullOr(Schema.Int),
  measurementStatus: Schema.Literals(["available", "unavailable"]),
  mergePending: Schema.Boolean,
  changedRows: Schema.Int,
  lastMergeAt: Schema.NullOr(Schema.Int),
});
export type MemoryFtsState = typeof FtsState.Type;
export type MemoryIndexTarget = {
  readonly memorySpaceId: M.MemorySpaceId;
  readonly memoryId: M.MemoryId;
  readonly revisionId: M.MemoryRevisionId;
  readonly generation: number;
};

export class Transaction extends Context.Service<
  Transaction,
  { readonly signals: M.MemoryChangeSignal[]; runnable: boolean }
  // @effect-diagnostics-next-line deterministicKeys:off -- Keeps the runtime key it had in MemoryStore.ts.
>()("goat/memory/MemoryStore/Transaction") {}
