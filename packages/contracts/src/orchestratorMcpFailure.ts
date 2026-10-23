import * as Schema from "effect/Schema";

import { RunId } from "./baseSchemas.ts";
import { CloudMachineErrorReason } from "./cloudMachines.ts";
import { HandoffErrorReason } from "./handoff.ts";
import { OrchestrationV2ProviderFailureClass } from "./orchestrationV2.ts";
import { ProviderHostSyncErrorCode } from "./providerHostSync.ts";

/**
 * A run that failed before its agent's first message: while GOAT prepared its workspace
 * (fetch, worktree, setup script), or when its provider refused to start it.
 */
export const OrchestratorMcpRunFailure = Schema.Struct({
  runId: RunId,
  stage: Schema.Literals(["workspace_preparation", "before_first_message"]),
  errorClass: OrchestrationV2ProviderFailureClass,
  /** Whether the same request can succeed later, when the failure says. */
  retryable: Schema.NullOr(Schema.Boolean),
  message: Schema.String,
  /** The redacted end of the preparation log: Git output and setup script output. */
  log: Schema.NullOr(Schema.String),
  /** goat_thread_retry runs the preparation again; only a failed preparation can be retried. */
  canRetry: Schema.Boolean,
});
export type OrchestratorMcpRunFailure = typeof OrchestratorMcpRunFailure.Type;

export const OrchestratorMcpFailureCode = Schema.Literals([
  "capability_denied",
  "parent_not_active",
  "provider_unavailable",
  "model_unavailable",
  "runtime_mode_escalation_denied",
  "interaction_mode_escalation_denied",
  "task_not_found",
  "task_not_cancellable",
  "thread_not_found",
  "run_not_found",
  "thread_not_sendable",
  "thread_not_interruptible",
  "invalid_request",
  "orchestration_error",
  "thread_credential_required",
  "target_required",
  "host_unavailable",
  // A fleet goal (or another named record) that does not exist, or a stale expectedGeneration.
  "not_found",
  "conflict",
  // GOAT Bot runs on another environment in this cluster; the message names it.
  "not_home",
  // fleet.pressure.admission is "block" and the target host is critical.
  "host_pressure",
  // A routed call named a tool the remote GOAT is too old to have; nothing ran.
  "remote_outdated",
]);
export type OrchestratorMcpFailureCode = typeof OrchestratorMcpFailureCode.Type;

/**
 * host_unavailable: SSH, the tunnel, or the remote server did not answer. ssh_failed: the SSH
 * call itself failed. remote_refused: the remote answered and refused, with its code in
 * remoteCode when it sent one. remote_outdated: the remote has no such tool, so nothing ran.
 * caller_changed: the caller's modes changed mid-call.
 */
export const SshDispatchFailureReason = Schema.Literals([
  "invalid_request",
  "host_unknown",
  "ssh_failed",
  "host_unavailable",
  "remote_refused",
  "remote_outdated",
  "caller_changed",
]);
export type SshDispatchFailureReason = typeof SshDispatchFailureReason.Type;

/**
 * link_refused: the host answered and refused (a spent or expired code, too little scope).
 * host_unavailable: it could not be reached or answered nonsense. storage_failed: this machine
 * could not read or write its links.
 */
export const LinkedHostFailureReason = Schema.Literals([
  "invalid_request",
  "link_refused",
  "host_unavailable",
  "storage_failed",
]);
export type LinkedHostFailureReason = typeof LinkedHostFailureReason.Type;

/** The literal of the domain failure an OrchestratorMcpFailure wraps. */
export const OrchestratorMcpFailureReason = Schema.Union([
  SshDispatchFailureReason,
  LinkedHostFailureReason,
  CloudMachineErrorReason,
  HandoffErrorReason,
  ProviderHostSyncErrorCode,
  // A remote task with this id is already launching or launched.
  Schema.Literal("duplicate_task"),
]);
export type OrchestratorMcpFailureReason = typeof OrchestratorMcpFailureReason.Type;

/**
 * `code` keeps the value existing callers match on. A handler that wraps another failure family
 * also keeps that family's literal in `reason`, and says when the work may already have run, so
 * the agent surface can classify it (docs/internals/agent-surface.md, "Result envelope").
 */
export class OrchestratorMcpFailure extends Schema.TaggedError<OrchestratorMcpFailure>()(
  "OrchestratorMcpFailure",
  {
    code: OrchestratorMcpFailureCode,
    message: Schema.String,
    reason: Schema.optionalKey(OrchestratorMcpFailureReason),
    /** A write may have reached its target before the failure, so repeating it may run twice. */
    mayHaveStarted: Schema.optionalKey(Schema.Boolean),
    /** The failure code a remote GOAT answered with, unchanged. */
    remoteCode: Schema.optionalKey(Schema.String),
  },
) {}
