import type { AgentSurfaceResult } from "@goat/contracts/agentSurface/envelope";
import type { OperationKind, OperationState } from "@goat/contracts/agentSurface/operation";

/** A call to an existing tool, which runs with that tool's own checks. */
export interface ToolCall {
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
}

/**
 * Where a kind reads its work: a status tool, or the caller's own handoff (a person has not acted
 * yet, or the work is the handoff's own continuation), then optionally a status tool.
 */
export type OperationSource =
  | { readonly tool: ToolCall }
  | { readonly handoffId: string; readonly then?: ToolCall };

/**
 * How one kind of long-running work maps onto the stores that already own it. `state` reads the
 * envelope its source produced; `cancel` names the kind's cancel tool given the latest read, or
 * nothing when nothing runs to cancel; `produce` finds the native id in the result that accepted
 * the work, or nothing when that result is already final.
 */
export interface OperationKindSpec {
  /** How long a handle stays valid; the native store may forget the work sooner (unknown). */
  readonly retentionMs: number;
  readonly pollAfterMs: number;
  readonly source: (nativeId: string) => OperationSource;
  readonly cancellable: boolean;
  readonly cancel?: (nativeId: string, current: AgentSurfaceResult) => ToolCall | undefined;
  readonly state: (result: AgentSurfaceResult, nativeId: string) => OperationState;
  readonly produce: (result: AgentSurfaceResult) => string | undefined;
}

type Fields = Readonly<Record<string, unknown>>;
const fieldsOf = (value: unknown): Fields | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Fields)
    : undefined;
const okFields = (result: AgentSurfaceResult) =>
  result.status === "ok" ? fieldsOf(result.value) : undefined;

const TASK_STATES: Readonly<Record<string, OperationState>> = {
  queued: "queued",
  // A pending approval or question inside a task is a runtime request, not a handoff.
  running: "running",
  waiting: "running",
  completed: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
  interrupted: "cancelled",
};

const task: OperationKindSpec = {
  retentionMs: 30 * 24 * 60 * 60_000,
  pollAfterMs: 5_000,
  source: (taskId) => ({ tool: { tool: "task_status", args: { taskId } } }),
  cancellable: true,
  cancel: (taskId) => ({ tool: "task_cancel", args: { taskId } }),
  state: (result) => TASK_STATES[String(okFields(result)?.status)] ?? "unknown",
  produce: (result) => {
    const value = okFields(result);
    const state = TASK_STATES[String(value?.status)];
    return typeof value?.taskId === "string" && (state === "queued" || state === "running")
      ? value.taskId
      : undefined;
  },
};

/** SSH setup is one setup operation on one host; a newer setup on the host supersedes it. */
const sshNative = (host: string, setupId: string) => JSON.stringify([host, setupId]);
const sshParts = (nativeId: string): readonly [string, string] => {
  const parsed: unknown = JSON.parse(nativeId);
  return Array.isArray(parsed) && typeof parsed[0] === "string" && typeof parsed[1] === "string"
    ? [parsed[0], parsed[1]]
    : ["", ""];
};
const sshStatus = (result: AgentSurfaceResult) => {
  const value = okFields(result);
  return value?.kind === "ok" ? fieldsOf(value.status) : undefined;
};

const sshSetup: OperationKindSpec = {
  retentionMs: 24 * 60 * 60_000,
  pollAfterMs: 3_000,
  source: (nativeId) => ({
    tool: { tool: "goat_ssh_host_status", args: { host: sshParts(nativeId)[0] } },
  }),
  cancellable: false,
  state: (result, nativeId) => {
    const status = sshStatus(result);
    const setup = fieldsOf(status?.setup);
    if (status === undefined || setup?.operationId !== sshParts(nativeId)[1]) return "unknown";
    if (status.failure !== undefined || status.state === "failed") return "failed";
    return setup.stage === "complete" ? "succeeded" : "running";
  },
  produce: (result) => {
    const status = sshStatus(result);
    const setup = fieldsOf(status?.setup);
    return typeof status?.host === "string" &&
      typeof setup?.operationId === "string" &&
      setup.stage !== "complete" &&
      status.failure === undefined
      ? sshNative(status.host, setup.operationId)
      : undefined;
  },
};

const SYNC = "sync:";
const APPROVAL = "approval:";
const SYNC_ERRORS: Readonly<Record<string, OperationState>> = {
  declined: "cancelled",
  cancelled: "cancelled",
  expired: "failed",
  start_failed: "failed",
};

/**
 * A provider sync, by its syncId or by the approval that starts it. The sync store keeps syncs for
 * two hours in memory, so an older or restarted one reads unknown while its handle is still valid.
 */
const providerSync: OperationKindSpec = {
  retentionMs: 24 * 60 * 60_000,
  pollAfterMs: 3_000,
  source: (nativeId) =>
    nativeId.startsWith(APPROVAL)
      ? {
          handoffId: nativeId.slice(APPROVAL.length),
          // oxlint-disable-next-line unicorn/no-thenable -- This wire field describes the next diagnostic operation; it is not a promise callback.
          then: {
            tool: "goat_provider_sync_status",
            args: { handoffId: nativeId.slice(APPROVAL.length) },
          },
        }
      : {
          tool: {
            tool: "goat_provider_sync_status",
            args: { syncId: nativeId.slice(SYNC.length) },
          },
        },
  cancellable: true,
  cancel: (nativeId, current) => {
    const syncId = nativeId.startsWith(SYNC)
      ? nativeId.slice(SYNC.length)
      : okFields(current)?.syncId;
    return typeof syncId === "string"
      ? { tool: "goat_provider_sync_cancel", args: { syncId } }
      : undefined;
  },
  state: (result) => {
    if (result.status === "error") return SYNC_ERRORS[result.error.reason] ?? "unknown";
    // goat_provider_sync answers { kind: "started", sync }; the status tool answers the sync.
    const answer = okFields(result);
    const value = answer?.kind === "started" ? fieldsOf(answer.sync) : answer;
    const hosts = Array.isArray(value?.hosts) ? value.hosts.map(fieldsOf) : undefined;
    if (hosts === undefined || typeof value?.done !== "boolean") return "unknown";
    if (!value.done) return "running";
    const phases = hosts.map((host) => host?.phase);
    if (phases.some((phase) => phase === "failed" || phase === "update_runtime")) return "failed";
    return phases.some((phase) => phase === "cancelled") ? "cancelled" : "succeeded";
  },
  produce: (result) => {
    if (result.status === "needs_human") return APPROVAL + result.handoff.handoffId;
    const value = okFields(result);
    const sync = fieldsOf(value?.sync);
    return value?.kind === "started" && typeof sync?.syncId === "string" && sync.done === false
      ? SYNC + sync.syncId
      : undefined;
  },
};

const HANDOFF_STATES: Readonly<Record<string, OperationState>> = {
  declined: "cancelled",
  cancelled: "cancelled",
  expired: "failed",
  failed: "failed",
};
const OUTCOME_STATES: Readonly<Record<string, OperationState>> = {
  applied: "succeeded",
  failed: "failed",
  // The outcome names the read that settles it (reconcile).
  unknown_outcome: "unknown",
};

/**
 * An approved change the server applies itself. Approved and applied are separate facts: the
 * handoff says a person approved, the change's recorded outcome says whether it was applied.
 */
const handoff: OperationKindSpec = {
  retentionMs: 24 * 60 * 60_000,
  pollAfterMs: 3_000,
  source: (handoffId) => ({ handoffId }),
  cancellable: false,
  state: (result) => {
    const value = okFields(result);
    const state = fieldsOf(value?.handoff)?.state;
    if (state !== "completed") return HANDOFF_STATES[String(state)] ?? "unknown";
    const outcome = fieldsOf(fieldsOf(value?.change)?.outcome)?.state;
    if (outcome !== undefined) return OUTCOME_STATES[String(outcome)] ?? "unknown";
    return value?.applying === true ? "running" : "unknown";
  },
  produce: (result) => (result.status === "needs_human" ? result.handoff.handoffId : undefined),
};

export const OPERATION_KINDS: Readonly<Record<OperationKind, OperationKindSpec>> = {
  task,
  ssh_setup: sshSetup,
  provider_sync: providerSync,
  handoff,
};
