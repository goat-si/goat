import type { OrchestrationV2ThreadLauncher, OrchestrationV2ThreadShell } from "@goat/contracts";

import { backgroundWorkHoldsCompletion } from "./orchestrationV2PendingBackgroundWork.ts";

/**
 * How a thread and the threads launched under it read at a glance, for the sidebar's launch
 * fold and goat_thread_list: someone has to answer, work continues, or everything is done.
 */
export type LaunchChildState = "attention" | "working" | "finished";
export type LaunchAttention = "approval" | "input";
/**
 * The most urgent state among a thread and what is folded under it; null when all finished.
 * "unseen" is finished work the user has not read, which only the sidebar knows.
 */
export type LaunchLift = LaunchAttention | "working" | "unseen";

export interface LaunchLiftInput {
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  /** The thread's runtime status; null before it ever ran. */
  readonly runtimeStatus: string | null | undefined;
  readonly pendingBackgroundTaskCount: number;
}

const WORKING_STATUSES: ReadonlySet<string> = new Set([
  "preparing",
  "starting",
  "running",
  "waiting",
  "queued",
]);
const LIFT_RANK: Record<LaunchLift, number> = { approval: 0, input: 1, working: 2, unseen: 3 };

/** A thread's own urgency, raised by a request one of its task.create subagents waits on. */
export function ownLaunchLift(
  thread: LaunchLiftInput,
  delegated?: LaunchAttention,
  unseen = false,
): LaunchLift | null {
  if (thread.hasPendingApprovals || delegated === "approval") return "approval";
  if (thread.hasPendingUserInput || delegated === "input") return "input";
  const status = thread.runtimeStatus;
  if (status != null && WORKING_STATUSES.has(status)) return "working";
  if (status === "idle" && thread.pendingBackgroundTaskCount > 0) return "working";
  return unseen ? "unseen" : null;
}

/**
 * Whether a thread folds under the thread that launched it: one started with thread.launch,
 * create_threads or ssh.thread_launch and not pinned. task.create children and provider
 * subagents belong to their parent's subagent model instead.
 */
export function foldsUnderLauncher(thread: {
  readonly launchedBy?: Pick<OrchestrationV2ThreadLauncher, "kind" | "via"> | undefined;
  readonly lineage: { readonly relationshipToParent: "fork" | "subagent" | null };
  readonly pinnedAt?: unknown;
}): boolean {
  const launcher = thread.launchedBy;
  return (
    launcher?.kind === "launch" &&
    launcher.via !== "delegate_task" &&
    thread.lineage.relationshipToParent !== "subagent" &&
    thread.pinnedAt == null
  );
}

/**
 * Whether a launched thread stays folded under its launcher once both are known. Live work under
 * a snoozed launcher, or finished work the user has not settled under a settled one, keeps its
 * own place so nothing hides.
 */
export function staysFoldedUnderLauncher(input: {
  readonly childLift: LaunchLift | null;
  readonly childSettled: boolean;
  readonly launcherSnoozed: boolean;
  readonly launcherSettled: boolean;
}): boolean {
  if (input.childLift !== null && input.launcherSnoozed) return false;
  const finished = input.childLift === null || input.childLift === "unseen";
  return !(finished && input.launcherSettled && !input.childSettled);
}

export const moreUrgentLaunchLift = (left: LaunchLift | null, right: LaunchLift | null) =>
  left === null ? right : right === null || LIFT_RANK[left] <= LIFT_RANK[right] ? left : right;

export const launchStateOfLift = (lift: LaunchLift | null): LaunchChildState =>
  lift === null || lift === "unseen" ? "finished" : lift === "working" ? "working" : "attention";

/** The launch fold's input from a server thread shell, read as clients present the shell. */
export function launchLiftInputOfShell(
  shell: Pick<
    OrchestrationV2ThreadShell,
    | "pendingRuntimeRequest"
    | "pendingBackgroundTasks"
    | "status"
    | "activityRunStatus"
    | "latestRunId"
    | "activeProviderThreadId"
  >,
): LaunchLiftInput {
  const tasks = shell.pendingBackgroundTasks ?? [];
  const parkAtIdle = backgroundWorkHoldsCompletion(tasks) && shell.status !== "failed";
  const runtimeStatus =
    shell.latestRunId === null && shell.activeProviderThreadId === null && !parkAtIdle
      ? null
      : parkAtIdle
        ? "idle"
        : (shell.activityRunStatus ?? shell.status);
  const request = shell.pendingRuntimeRequest;
  const working =
    runtimeStatus === "preparing" || runtimeStatus === "starting" || runtimeStatus === "running";
  return {
    hasPendingApprovals:
      request !== null && request.kind !== "user_input" && request.kind !== "auth_refresh",
    hasPendingUserInput: request?.kind === "user_input" && (request.blocking !== false || !working),
    runtimeStatus,
    pendingBackgroundTaskCount: tasks.length,
  };
}
