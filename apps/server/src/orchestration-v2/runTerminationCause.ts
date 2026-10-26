import type {
  OrchestrationV2ExecutionNode,
  OrchestrationV2ProviderThread,
  OrchestrationV2Run,
  OrchestrationV2RunTerminationCause,
  OrchestrationV2TurnItem,
} from "@goat/contracts";
import type * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as Schema from "effect/Schema";
import { CommandPolicyCapabilityUnsupportedError } from "./CommandPolicy.ts";

type Kind = OrchestrationV2RunTerminationCause["kind"];
type Terminal = Extract<ProviderAdapter.ProviderAdapterV2Event, { readonly type: "turn.terminal" }>;

const isStreamError = Schema.is(ProviderAdapter.ProviderAdapterEventStreamError);
const isCapabilityUnsupported = Schema.is(CommandPolicyCapabilityUnsupportedError);

export function stopTerminationKind(
  reason: string | undefined,
  userStopReason: string,
  absentIsPerson = false,
): Kind {
  if (reason === userStopReason || (absentIsPerson && reason === undefined)) return "person_stop";
  if (reason === "Stopped by an agent" || reason?.startsWith("Stopped by an agent: ") === true)
    return "agent_stop";
  return "unknown";
}

export function terminalTerminationCause(
  terminal: Terminal,
  reason: string | undefined,
  override: Kind | undefined,
  userStopReason: string,
): OrchestrationV2RunTerminationCause | undefined {
  if (terminal.status === "completed") return undefined;
  if (terminal.status === "failed")
    return {
      kind: override ?? (terminal.failure.class === "usage_limit" ? "quota" : "provider_error"),
    };
  if (terminal.status === "interrupted" || terminal.status === "cancelled")
    return { kind: stopTerminationKind(reason, userStopReason) };
  return { kind: "unknown" };
}

/**
 * A run that fails before its provider turn starts. An error item's failure class says whose
 * problem it was; a failed setup command or an unclassified failure is preparation.
 */
export function beforeStartTerminationCause(item: {
  readonly type: string;
  readonly failure?: { readonly class: string };
}): OrchestrationV2RunTerminationCause {
  const failureClass = item.type === "error" ? item.failure?.class : undefined;
  if (failureClass === "validation_error") return { kind: "validation_error" };
  if (failureClass === "usage_limit") return { kind: "quota" };
  if (failureClass === "provider_error" || failureClass === "permission_error")
    return { kind: "provider_error" };
  return { kind: "preparation_failed" };
}

/** The run.updated payload for a run settled before its provider turn starts. */
export function settledBeforeStartRun(
  run: OrchestrationV2Run,
  settled: {
    readonly status: "completed" | "failed";
    readonly now: DateTime.Utc;
    readonly item: Parameters<typeof beforeStartTerminationCause>[0];
  },
  started: { readonly startedAt?: DateTime.Utc },
): OrchestrationV2Run {
  return {
    ...run,
    status: settled.status,
    ...started,
    completedAt: settled.now,
    ...(settled.status === "failed"
      ? { terminationCause: beforeStartTerminationCause(settled.item) }
      : {}),
  };
}

export function queuedStartFailureKind(cause: unknown): Kind {
  const failure =
    typeof cause === "object" &&
    cause !== null &&
    "_tag" in cause &&
    cause._tag === "OrchestratorDispatchError" &&
    "cause" in cause
      ? cause.cause
      : cause;
  return isCapabilityUnsupported(failure) ? "validation_error" : "provider_error";
}

export function providerProcessExitCause(cause: unknown): boolean {
  if (isStreamError(cause)) return cause.source === "provider_process_exit";
  if (
    typeof cause === "object" &&
    cause !== null &&
    "_tag" in cause &&
    cause._tag === "RunExecutionIngestError" &&
    "cause" in cause
  )
    return providerProcessExitCause(cause.cause);
  return false;
}

export function makeInterruptResultTurnItem(input: {
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly run: OrchestrationV2Run;
  readonly rootNode: OrchestrationV2ExecutionNode;
  readonly providerThread: OrchestrationV2ProviderThread;
  /** The Stop's own reason, from its run_interrupt_request item. */
  readonly reason: string | undefined;
  readonly completedAt: DateTime.Utc;
}): OrchestrationV2TurnItem {
  return {
    id: input.idAllocator.derive.runSignalTurnItem({
      runId: input.run.id,
      signal: "interrupt-result",
    }),
    threadId: input.run.threadId,
    runId: input.run.id,
    nodeId: input.rootNode.id,
    providerThreadId: input.providerThread.id,
    providerTurnId: input.rootNode.providerTurnId,
    nativeItemRef: null,
    parentItemId: input.idAllocator.derive.runSignalTurnItem({
      runId: input.run.id,
      signal: "interrupt-request",
    }),
    ordinal: input.run.ordinal * 100 + 98,
    status: "interrupted",
    title: "Interrupted",
    startedAt: input.completedAt,
    completedAt: input.completedAt,
    updatedAt: input.completedAt,
    type: "run_interrupt_result",
    message: input.reason ?? "Stopped by the provider",
  };
}
