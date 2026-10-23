import type { AgentSurfaceResult } from "@goat/contracts/agentSurface/envelope";
import type { OperationKind, OperationState } from "@goat/contracts/agentSurface/operation";

/** A call to an existing tool, which runs with that tool's own checks. */
export interface ToolCall {
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
}

/**
 * How one kind of long-running work maps onto the tools that already own it. `state` reads the
 * envelope of the kind's status tool; `produce` finds the native id in the result that accepted
 * the work, or nothing when that result is already final.
 */
export interface OperationKindSpec {
  /** How long the native store keeps the work; an older handle is expired. */
  readonly retentionMs: number;
  readonly pollAfterMs: number;
  readonly status: (nativeId: string) => ToolCall;
  readonly cancel?: (nativeId: string) => ToolCall;
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
  status: (taskId) => ({ tool: "task_status", args: { taskId } }),
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
  status: (nativeId) => ({ tool: "goat_ssh_host_status", args: { host: sshParts(nativeId)[0] } }),
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

export const OPERATION_KINDS: Readonly<Record<OperationKind, OperationKindSpec>> = {
  task,
  ssh_setup: sshSetup,
};
