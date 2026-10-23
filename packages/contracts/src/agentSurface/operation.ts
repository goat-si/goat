import * as Schema from "effect/Schema";

/**
 * Long-running work behind one handle (docs/internals/agent-surface.md, "Long-running work").
 * Kinds and states ship with the producers that emit them.
 */
export const OperationKind = Schema.Literals(["task", "ssh_setup"]);
export type OperationKind = typeof OperationKind.Type;

export const OperationState = Schema.Literals([
  "queued",
  "running",
  "waiting_human",
  "succeeded",
  "failed",
  "cancelled",
  "unknown",
]);
export type OperationState = typeof OperationState.Type;

export const OperationRef = Schema.Struct({
  /** Opaque and signed by this environment; it names the work and grants nothing. */
  operationId: Schema.String,
  kind: OperationKind,
  state: OperationState,
  cancellable: Schema.Boolean,
  pollAfterMs: Schema.optionalKey(Schema.Int),
  /** While waiting_human: the open handoff a person must act on. */
  handoffId: Schema.optionalKey(Schema.String),
});
export type OperationRef = typeof OperationRef.Type;

export const OPERATION_WAIT_MAX_MS = 300_000;

export const isTerminalOperationState = (state: OperationState) =>
  state === "succeeded" || state === "failed" || state === "cancelled";

/**
 * not_found: the handle was not issued here, or to this caller. expired: it is older than its
 * kind keeps records. not_cancellable: the kind has no cancel path, or nothing runs to cancel.
 */
export const OperationErrorReason = Schema.Literals(["not_found", "expired", "not_cancellable"]);
export type OperationErrorReason = typeof OperationErrorReason.Type;

export class OperationError extends Schema.TaggedError<OperationError>()("OperationError", {
  reason: OperationErrorReason,
  message: Schema.String,
}) {}
