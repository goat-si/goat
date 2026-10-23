import * as Schema from "effect/Schema";

import { OperationRef } from "./operation.ts";

/**
 * One result shape for goat_call and the CLI's --json output (docs/internals/agent-surface.md,
 * "Result envelope"). Legacy tool names keep their own shapes; this classifies them after the
 * fact from the JSON a tool already returned, using a table keyed by each domain's declared
 * literals. Tags are never matched by pattern, so a new failure is caught by the exhaustive
 * test instead of being classified by accident.
 */
export const AgentSurfaceErrorCode = Schema.Literals([
  "invalid_request",
  "unauthenticated",
  "permission_denied",
  "not_found",
  "conflict",
  "unavailable",
  "timeout",
  "expired",
  "cancelled",
  "internal",
  "resource_exhausted",
  "failed_precondition",
  "unknown_outcome",
]);
export type AgentSurfaceErrorCode = typeof AgentSurfaceErrorCode.Type;

export const AgentSurfaceError = Schema.Struct({
  code: AgentSurfaceErrorCode,
  /** The domain's own code, reason, or error tag, unchanged. */
  reason: Schema.String,
  message: Schema.String,
  /** Computed for this call: true only when repeating it cannot duplicate an effect. */
  retryable: Schema.Boolean,
  details: Schema.optionalKey(Schema.Unknown),
});
export type AgentSurfaceError = typeof AgentSurfaceError.Type;

/**
 * Only fields something produces today. nextCursor and deprecated join with the rollout steps
 * that emit them, so no agent learns to read a field that is never set.
 */
export const AgentSurfaceMeta = Schema.Struct({
  /** Where a routed call ran. */
  host: Schema.optionalKey(Schema.String),
  /** Non-text content blocks, such as screenshots, as the tool returned them. */
  content: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  /** Accepted work still running; an ok result without it is finished. */
  operation: Schema.optionalKey(OperationRef),
});
export type AgentSurfaceMeta = typeof AgentSurfaceMeta.Type;

/** The wire form of HandoffSummary; human instructions never reach the agent. */
export const AgentSurfaceHandoff = Schema.Struct({
  handoffId: Schema.String,
  kind: Schema.String,
  title: Schema.String,
  state: Schema.String,
  expiresAt: Schema.NullOr(Schema.String),
  targetPath: Schema.String,
});
export type AgentSurfaceHandoff = typeof AgentSurfaceHandoff.Type;

/** What the agent calls after the person acts, when the server does not continue by itself. */
export const AgentSurfaceNextCall = Schema.Struct({
  after: Schema.Literals(["approval", "terminal", "input"]),
  path: Schema.String,
  args: Schema.optionalKey(Schema.Unknown),
});
export type AgentSurfaceNextCall = typeof AgentSurfaceNextCall.Type;

export const AgentSurfaceResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("ok"),
    value: Schema.Unknown,
    meta: Schema.optionalKey(AgentSurfaceMeta),
  }),
  Schema.Struct({
    status: Schema.Literal("error"),
    error: AgentSurfaceError,
    meta: Schema.optionalKey(AgentSurfaceMeta),
  }),
  // A third status because the call has not failed: retrying would start a second human flow.
  Schema.Struct({
    status: Schema.Literal("needs_human"),
    handoff: AgentSurfaceHandoff,
    next: Schema.optionalKey(AgentSurfaceNextCall),
    meta: Schema.optionalKey(AgentSurfaceMeta),
  }),
]);
export type AgentSurfaceResult = typeof AgentSurfaceResult.Type;

export interface FailureClass {
  readonly code: AgentSurfaceErrorCode;
  /** The failure proves nothing ran, so even a write without a key may be repeated. */
  readonly nothingRan?: true;
}
const c = (code: AgentSurfaceErrorCode): FailureClass => ({ code });
const before = (code: AgentSurfaceErrorCode): FailureClass => ({ code, nothingRan: true });

/**
 * Every domain literal the live surface can return, keyed by the literal itself: a failure's
 * code or reason, or its tag when it has neither. apps/server/src/mcp/agentSurface.test.ts walks
 * every served tool's failure and result schemas and fails on a literal with no row.
 */
export const FAILURE_CLASSES: Readonly<Record<string, FailureClass>> = {
  // OrchestratorMcpFailure
  capability_denied: before("permission_denied"),
  runtime_mode_escalation_denied: before("permission_denied"),
  interaction_mode_escalation_denied: before("permission_denied"),
  thread_credential_required: before("unauthenticated"),
  task_not_found: before("not_found"),
  thread_not_found: before("not_found"),
  run_not_found: before("not_found"),
  not_found: before("not_found"),
  parent_not_active: before("conflict"),
  task_not_cancellable: before("conflict"),
  thread_not_sendable: before("conflict"),
  thread_not_interruptible: before("conflict"),
  not_home: before("conflict"),
  conflict: before("conflict"),
  provider_unavailable: before("unavailable"),
  model_unavailable: before("unavailable"),
  // A routed call may have reached the remote before it stopped answering.
  host_unavailable: c("unavailable"),
  host_pressure: before("resource_exhausted"),
  invalid_request: before("invalid_request"),
  target_required: before("invalid_request"),
  orchestration_error: c("internal"),
  // The MCP layer refused the arguments before the tool ran.
  invalid_params: before("invalid_request"),
  // SSH dispatch (OrchestratorMcpFailure reason)
  ssh_failed: c("unavailable"),
  // Classified by remoteCode when the remote sent a known one.
  remote_refused: c("failed_precondition"),
  caller_changed: before("conflict"),
  duplicate_task: before("conflict"),
  // Linked hosts (OrchestratorMcpFailure reason)
  link_refused: before("permission_denied"),
  // Cloud machines (CloudMachineErrorReason)
  not_configured: before("failed_precondition"),
  invalid_key: before("unauthenticated"),
  scope_denied: before("permission_denied"),
  billing_required: before("failed_precondition"),
  limit_reached: before("resource_exhausted"),
  snapshot_expired: before("expired"),
  stopped: before("failed_precondition"),
  not_ready: before("failed_precondition"),
  readiness_timeout: c("timeout"),
  ssh_config_failed: c("internal"),
  ssh_config_overridden: c("failed_precondition"),
  forget_refused: before("failed_precondition"),
  protocol_error: c("internal"),
  transport_error: c("unavailable"),
  storage_failed: c("internal"),
  // Handoffs (HandoffErrorReason) and provider host sync (ProviderHostSyncErrorCode)
  expired: before("expired"),
  // Operations (OperationErrorReason): not_found and expired are classified above.
  not_cancellable: before("failed_precondition"),
  unavailable: c("unavailable"),
  denied: before("permission_denied"),
  start_failed: c("internal"),
  // SecretRequestError
  load_failed: c("internal"),
  already_answered: before("conflict"),
  agent_stopped: before("cancelled"),
  store_failed: c("internal"),
  record_failed: c("internal"),
  invalid_ref: before("invalid_request"),
  read_failed: c("internal"),
  ref_unavailable: before("not_found"),
  ref_expired: before("expired"),
  consume_failed: c("internal"),
  // SSH hosts (SshHostErrorCode)
  host_unknown: before("not_found"),
  host_unreachable: c("unavailable"),
  alias_conflict: before("conflict"),
  unsupported: before("failed_precondition"),
  declined: before("cancelled"),
  cancelled: c("cancelled"),
  operation_failed: c("internal"),
  // SSH workspace handoff (SshWorkspaceCode)
  invalid_target: before("invalid_request"),
  project_not_found: before("not_found"),
  thread_project_mismatch: before("invalid_request"),
  thread_busy: before("conflict"),
  caller_not_authorized: before("permission_denied"),
  thread_worktree_invalid: before("failed_precondition"),
  not_git_repository: before("failed_precondition"),
  project_not_repo_root: before("failed_precondition"),
  project_read_failed: c("internal"),
  remote_unsupported: before("failed_precondition"),
  environment_mismatch: before("failed_precondition"),
  invalid_remote_response: c("internal"),
  snapshot_failed: c("internal"),
  unsupported_snapshot: before("failed_precondition"),
  head_changed: before("conflict"),
  secret_candidate: before("failed_precondition"),
  foreign_path: before("invalid_request"),
  remote_init_failed: c("internal"),
  push_failed: c("internal"),
  push_ref_conflict: c("conflict"),
  push_oid_mismatch: c("conflict"),
  launch_refused: before("failed_precondition"),
  // The thread may have started; the error's message names the read that settles it.
  launch_uncertain: c("unknown_outcome"),
  // clientRequestId reservations (docs/internals/agent-surface.md#idempotency); nothing runs.
  in_progress: before("conflict"),
  idempotency_mismatch: before("conflict"),
  // The first call started and never recorded an outcome; details.reconcile names the read.
  outcome_unknown: c("unknown_outcome"),
  invalid_branch: before("invalid_request"),
  source_not_found: before("not_found"),
  source_ambiguous: before("invalid_request"),
  fetch_failed: c("unavailable"),
  // Worktrees (WorktreeMcpFailure)
  already_in_worktree: before("conflict"),
  handoff_in_progress: before("conflict"),
  // Fleet rescheduling refusals
  no_capacity: before("resource_exhausted"),
  host_still_answers: before("failed_precondition"),
  budget: before("resource_exhausted"),
  no_resume_point: before("failed_precondition"),
  unsupported_remote: before("failed_precondition"),
  not_allowed: before("permission_denied"),
  // Computer use refusals
  disabled: before("failed_precondition"),
  held: before("conflict"),
  not_unattended: before("failed_precondition"),
  // Browser preview control (PreviewAutomationControlReason)
  agentMismatch: before("conflict"),
  humanControl: before("conflict"),
  tabRequired: before("invalid_request"),
  closed: before("not_found"),
  interrupted: c("cancelled"),
  dialogPending: before("failed_precondition"),
  tabLimit: before("resource_exhausted"),
  PreviewAutomationUnavailableError: before("permission_denied"),
  McpCapabilityUnavailableError: before("permission_denied"),
  PreviewAutomationNoAvailableHostError: before("unavailable"),
  PreviewAutomationUnsupportedClientError: before("failed_precondition"),
  PreviewAutomationTabNotFoundError: before("not_found"),
  PreviewAutomationTimeoutError: c("timeout"),
  PreviewAutomationExecutionError: c("internal"),
  PreviewAutomationInvalidSelectorError: before("invalid_request"),
  PreviewAutomationTargetNotEditableError: before("invalid_request"),
  PreviewAutomationResultTooLargeError: c("resource_exhausted"),
  PreviewAutomationClientDisconnectedError: c("unavailable"),
  PreviewAutomationRequestQueueClosedError: before("unavailable"),
  PreviewAutomationRemoteUnavailableError: c("unavailable"),
  PreviewAutomationMalformedResponseError: c("internal"),
  PreviewAutomationRecordingTransferError: c("internal"),
  PreviewAutomationRecordingDesktopUpdateRequiredError: before("failed_precondition"),
  PreviewAutomationRecordingTooLargeError: c("resource_exhausted"),
  PreviewAutomationRecordingDeadlineExpiredError: c("timeout"),
  DeviceToolUnavailableError: before("failed_precondition"),
  DeviceHostUnavailableError: before("unavailable"),
  DevicePlatformUnavailableError: before("failed_precondition"),
  DeviceNotFoundError: before("not_found"),
  disk_space: c("resource_exhausted"),
  timeout: c("timeout"),
  launch_failed: c("internal"),
  helper_missing: before("failed_precondition"),
  command_failed: c("internal"),
  invalid_payload: c("internal"),
  request_failed: c("internal"),
  settings_failed: c("internal"),
  hub_rejected: c("internal"),
  PullRequestUrlInvalidError: before("invalid_request"),
  PullRequestTargetIncompleteError: before("invalid_request"),
  PullRequestHostRequiredError: before("invalid_request"),
  PullRequestThreadRequiredError: before("invalid_request"),
  PullRequestThreadNotFoundError: before("not_found"),
  PullRequestProjectNotFoundError: before("not_found"),
  PullRequestNotOpenError: before("failed_precondition"),
  PullRequestWatchFromSubagentError: before("failed_precondition"),
  PullRequestLinkFailedError: c("internal"),
  PullRequestUnlinkFailedError: c("internal"),
  PullRequestListFailedError: c("internal"),
  PullRequestWatchFailedError: c("internal"),
  PullRequestGuideFailedError: c("internal"),
};

const TRANSIENT: ReadonlySet<AgentSurfaceErrorCode> = new Set([
  "unavailable",
  "timeout",
  "resource_exhausted",
  "internal",
]);

/** How the call ran, which decides whether repeating it is safe. */
export interface CallContext {
  readonly effect: "read" | "write" | "destructive";
  /** The write carried a clientRequestId the server deduplicates. */
  readonly deduplicated?: boolean;
  /** Resolves a legacy tool name in a next-call hint to its registry path. */
  readonly pathOf?: (toolName: string) => string | undefined;
}

export const classifyFailure = (reason: string, tag?: string): FailureClass =>
  FAILURE_CLASSES[reason] ??
  (tag === undefined ? undefined : FAILURE_CLASSES[tag]) ??
  c("internal");

const retryableFor = (failure: FailureClass, context: CallContext) =>
  failure.code !== "unknown_outcome" &&
  TRANSIENT.has(failure.code) &&
  (context.effect === "read" || context.deduplicated === true || failure.nothingRan === true);

/**
 * What a keyed write's result means for its reservation. A transient refusal that ran nothing
 * frees the key, so the same request can run once the condition clears. A failure that may
 * have left effects holds the key as unknown. Anything else is kept and replayed, errors
 * included: a permission refusal can follow a partial effect, so it never frees the key.
 * `declared` is the failure's own literal when the server still holds the error.
 */
export const settlementOf = (
  result: AgentSurfaceResult,
  declared?: { readonly _tag: string; readonly code?: string },
): "completed" | "released" | "unknown" => {
  if (result.status !== "error") return "completed";
  const failure =
    (declared?.code === undefined ? undefined : FAILURE_CLASSES[declared.code]) ??
    (declared === undefined ? undefined : FAILURE_CLASSES[declared._tag]) ??
    FAILURE_CLASSES[result.error.reason] ??
    c(result.error.code);
  if (result.error.code === "unknown_outcome" || failure.code === "unknown_outcome")
    return "unknown";
  if (!TRANSIENT.has(failure.code)) return "completed";
  return failure.nothingRan === true ? "released" : "unknown";
};

const stringField = (value: unknown, key: string) => {
  const field =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)[key]
      : undefined;
  return typeof field === "string" && field !== "" ? field : undefined;
};

/**
 * The declared domain literal behind a failure, which the MCP layer may have flattened to text.
 * Only literals the classification table names count: an undeclared failure is one the direct
 * call deliberately scrubs, so it must not leak even its tag. Free text such as a reason string
 * or a computed message never leaves through here.
 */
export const declaredFailureLiteral = (
  error: unknown,
): { readonly _tag: string; readonly code?: string } | undefined => {
  const tag = stringField(error, "_tag");
  if (tag === undefined) return undefined;
  // A wrapper keeps a legacy code and names the wrapped literal in reason; the declared reason
  // wins, as fromFailure documents.
  const literal = (["reason", "code", "failureCode"] as const)
    .map((key) => stringField(error, key))
    .find((value) => value !== undefined && FAILURE_CLASSES[value] !== undefined);
  if (literal !== undefined) return { _tag: tag, code: literal };
  return FAILURE_CLASSES[tag] === undefined ? undefined : { _tag: tag };
};

type Fields = Readonly<Record<string, unknown>>;
const asFields = (value: unknown): Fields | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Fields)
    : undefined;
const stringOf = (fields: Fields | undefined, key: string) => {
  const value = fields?.[key];
  return typeof value === "string" && value !== "" ? value : undefined;
};
const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};
const REASON_KEYS = ["code", "reason", "failureCode"] as const;
const OMITTED_DETAILS: ReadonlySet<string> = new Set([
  "_tag",
  ...REASON_KEYS,
  "message",
  "kind",
  "status",
]);

/**
 * Classifies a failure from its encoded fields: a domain code, reason, or error tag. A server
 * holding the original error passes its computed message as `message`. A wrapper such as
 * OrchestratorMcpFailure keeps a legacy `code` and names the wrapped literal in `reason`, so a
 * declared reason wins; prose in a `reason` field has no row and falls back to the code.
 */
export const fromFailure = (fields: Fields, context: CallContext): AgentSurfaceResult => {
  const tag = stringOf(fields, "_tag");
  const declared = stringOf(fields, "reason");
  const reason =
    (declared !== undefined && FAILURE_CLASSES[declared] !== undefined ? declared : undefined) ??
    REASON_KEYS.map((key) => stringOf(fields, key)).find((value) => value !== undefined) ??
    tag ??
    "unknown";
  const remoteCode = stringOf(fields, "remoteCode");
  const failure =
    fields.mayHaveStarted === true
      ? c("unknown_outcome")
      : ((remoteCode === undefined ? undefined : FAILURE_CLASSES[remoteCode]) ??
        classifyFailure(reason, tag));
  // Tagged errors often compute their message, so the encoded form may carry none.
  const message =
    stringOf(fields, "message") ?? stringOf(fields, "detail") ?? `The call failed: ${reason}.`;
  const details = Object.fromEntries(
    Object.entries(fields).filter(([key]) => !OMITTED_DETAILS.has(key)),
  );
  return {
    status: "error",
    error: {
      code: failure.code,
      reason,
      message,
      retryable: retryableFor(failure, context),
      ...(Object.keys(details).length === 0 ? {} : { details }),
    },
  };
};

const isHandoff = Schema.is(AgentSurfaceHandoff);
const AFTER: ReadonlySet<string> = new Set(["approval", "terminal", "input"]);

/** Today's next hints name a tool (`call`); the envelope names its registry path. */
const nextCall = (value: unknown, context: CallContext): AgentSurfaceNextCall | undefined => {
  const fields = asFields(value);
  const after = stringOf(fields, "after");
  const target = stringOf(fields, "path") ?? stringOf(fields, "call");
  if (after === undefined || !AFTER.has(after) || target === undefined) return undefined;
  return {
    after: after as AgentSurfaceNextCall["after"],
    path: context.pathOf?.(target) ?? target,
    ...(fields?.args === undefined ? {} : { args: fields.args }),
  };
};

const isRefusal = (fields: Fields) =>
  (fields.kind === "error" || fields.kind === "refused" || fields.status === "refused") &&
  REASON_KEYS.some((key) => stringOf(fields, key) !== undefined);

export interface ToolResultLike {
  readonly isError?: boolean | undefined;
  readonly structuredContent?: unknown;
  readonly content: ReadonlyArray<unknown>;
}

/** Classifies one MCP tool result. Domain states inside a successful value stay ok. */
export const fromToolResult = (
  result: ToolResultLike,
  context: CallContext,
): AgentSurfaceResult => {
  const blocks = result.content.map(asFields);
  const texts = blocks.flatMap((block) =>
    block?.type === "text" && typeof block.text === "string" ? [block.text] : [],
  );
  const others = result.content.filter((_, index) => blocks[index]?.type !== "text");
  const structured = asFields(result.structuredContent);
  const [onlyText] = texts;
  const parsedText = texts.length === 1 && onlyText !== undefined ? parseJson(onlyText) : undefined;

  // Image tools report failures inside their structured content; a value may also have an error field.
  const nested = result.isError === true ? asFields(structured?.error) : undefined;
  if (nested !== undefined && stringOf(nested, "_tag") !== undefined)
    return fromFailure(
      stringOf(nested, "message") === undefined && texts.length > 0
        ? { ...nested, message: texts.join("\n") }
        : nested,
      context,
    );
  if (result.isError === true) {
    const encoded = asFields(parsedText) ?? structured;
    if (encoded !== undefined && REASON_KEYS.concat().some((key) => key in encoded))
      return fromFailure(encoded, context);
    if (encoded !== undefined && encoded._tag !== undefined) return fromFailure(encoded, context);
    // Plain text says nothing about what ran, so it is never classified by its wording.
    return {
      status: "error",
      error: {
        code: "internal",
        reason: "tool_error",
        message: texts.join("\n") || "The tool failed without a message.",
        retryable: context.effect === "read",
      },
    };
  }

  const value =
    result.structuredContent ?? parsedText ?? (texts.length > 0 ? texts.join("\n") : null);
  const fields = asFields(value);
  if (
    fields !== undefined &&
    (fields.kind === "needs_human" || fields.outcome === "needs_human") &&
    isHandoff(fields.handoff)
  ) {
    const next = nextCall(fields.next, context);
    return {
      status: "needs_human",
      handoff: fields.handoff,
      ...(next === undefined ? {} : { next }),
    };
  }
  if (fields !== undefined && isRefusal(fields)) return fromFailure(fields, context);
  return {
    status: "ok",
    value,
    ...(others.length === 0 ? {} : { meta: { content: others } }),
  };
};

/** The MCP layer refused the arguments before the tool ran. */
export const fromInvalidParams = (message: string): AgentSurfaceResult => ({
  status: "error",
  error: { code: "invalid_request", reason: "invalid_params", message, retryable: false },
});
