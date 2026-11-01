import * as Schema from "effect/Schema";

import {
  CheckpointId,
  EnvironmentId,
  IsoDateTime,
  ProjectId,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";

export const THREAD_REPLICA_MAX_BYTES = 8 * 1024 * 1024;
export const THREAD_REPLICA_RETENTION_MS = 7 * 24 * 60 * 60_000;
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const GitOid = Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u));
const OperationId = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,100}$/u));

export const ThreadReplicaMetadata = Schema.Struct({
  sourceEnvironmentId: EnvironmentId,
  sourceThreadId: ThreadId,
  runId: RunId,
  checkpointId: CheckpointId,
  repositoryKey: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)),
  capturedAt: IsoDateTime,
  headOid: GitOid,
  commitOid: GitOid,
  replicaRef: Schema.String.check(Schema.isPattern(/^refs\/goat\/replicas\/[a-zA-Z0-9_-]+\/0$/u)),
  bytes: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 1, maximum: THREAD_REPLICA_MAX_BYTES }),
  ),
  sha256: Digest,
  contextSha256: Digest,
  /** Recovery carries bounded conversation context, not a complete provider session. */
  contextKind: Schema.Literal("bounded_conversation"),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  modelSelection: ModelSelection,
});
export type ThreadReplicaMetadata = typeof ThreadReplicaMetadata.Type;

/** Only the authorized capture/restore transport carries contents; generic watch DTOs never do. */
export const ThreadReplicaPayload = Schema.Struct({
  ...ThreadReplicaMetadata.fields,
  bundleBase64: Schema.String.check(
    Schema.isMaxLength(Math.ceil(THREAD_REPLICA_MAX_BYTES / 3) * 4),
  ),
  context: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32_000)),
});
export type ThreadReplicaPayload = typeof ThreadReplicaPayload.Type;

export const ThreadReplicaCaptureInput = Schema.Struct({ threadId: ThreadId, runId: RunId });
export type ThreadReplicaCaptureInput = typeof ThreadReplicaCaptureInput.Type;
export const ThreadReplicaCaptureResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal("captured"), replica: ThreadReplicaPayload }),
  Schema.Struct({
    status: Schema.Literal("skipped"),
    reason: Schema.Literals([
      "checkpoint_not_ready",
      "context_unavailable",
      "repository_unknown",
      "too_large",
      "excluded_files",
      "incomplete_checkpoint",
      "checkpoint_identity_mismatch",
      "capture_failed",
      "invalid",
    ]),
  }),
]);
export type ThreadReplicaCaptureResult = typeof ThreadReplicaCaptureResult.Type;

export const ThreadReplicaRestoreInput = Schema.Struct({
  operationId: OperationId,
  projectId: ProjectId,
  replica: ThreadReplicaPayload,
  modelSelection: Schema.optional(ModelSelection),
});
export type ThreadReplicaRestoreInput = typeof ThreadReplicaRestoreInput.Type;
export const ThreadReplicaRestoreResult = Schema.Struct({
  operationId: OperationId,
  status: Schema.Literals(["launch_unknown", "launched", "refused"]),
  reason: Schema.optional(Schema.String.check(Schema.isMaxLength(300))),
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
});
export type ThreadReplicaRestoreResult = typeof ThreadReplicaRestoreResult.Type;

export const ThreadReplicaRecoveryInput = Schema.Struct({
  host: TrimmedNonEmptyString,
  threadId: ThreadId,
  fromReplicatedCheckpoint: Schema.Literal(true),
  /** The run shown by watch status, so a caller cannot unknowingly recover a different copy. */
  expectedRunId: RunId,
  destinationHost: Schema.optional(TrimmedNonEmptyString),
  destinationProjectId: ProjectId,
  modelSelection: Schema.optional(ModelSelection),
});
export type ThreadReplicaRecoveryInput = typeof ThreadReplicaRecoveryInput.Type;

export const ThreadReplicaStatus = Schema.Struct({
  checkpointReplication: Schema.Literals(["on", "off"]),
  replica: Schema.NullOr(
    Schema.Struct({
      runId: RunId,
      capturedAt: IsoDateTime,
      bytes: Schema.Number,
      sha256: Digest,
      contextSha256: Digest,
      repositoryKey: Schema.String,
    }),
  ),
  skippedReason: Schema.NullOr(Schema.String),
  recovery: Schema.NullOr(
    Schema.Struct({
      operationId: OperationId,
      status: Schema.Literals(["reserved", "launch_unknown", "launched"]),
      destinationHost: Schema.NullOr(Schema.String),
      threadId: Schema.NullOr(ThreadId),
      runId: Schema.NullOr(RunId),
      sourceInterruptPending: Schema.Boolean,
    }),
  ),
});
export type ThreadReplicaStatus = typeof ThreadReplicaStatus.Type;

export const ThreadReplicaSettingInput = Schema.Struct({
  host: TrimmedNonEmptyString,
  checkpointReplication: Schema.Literals(["on", "off"]),
});
export type ThreadReplicaSettingInput = typeof ThreadReplicaSettingInput.Type;

export const ThreadReplicaReconcileInput = Schema.Struct({
  operationId: OperationId,
  requestDigest: Digest,
});
export type ThreadReplicaReconcileInput = typeof ThreadReplicaReconcileInput.Type;
