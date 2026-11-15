import type {
  NodeId,
  OrchestrationV2ForceStopThreadError,
  OrchestrationV2ForceStopThreadInput,
  OrchestrationV2ForceStopThreadResult,
  OrchestrationV2TurnItem,
  RunId,
  ThreadId,
} from "@goat/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import type * as Orchestrator from "./Orchestrator.ts";
import { latestActiveRun } from "./ThreadManagementService.ts";

/** Why a parent's Force stop of its task was refused; nothing was stopped. */
export class DelegatedForceStopRefused extends Data.TaggedError("DelegatedForceStopRefused")<{
  readonly reason: "not_owner" | "not_unresponsive" | "remote";
  readonly message: string;
}> {}

/** Whether the run's latest Stop timed out unanswered, the state clients show as Force stop. */
function stopIsUnresponsive(runId: RunId, items: ReadonlyArray<OrchestrationV2TurnItem>): boolean {
  let unresponsive = false;
  for (const item of items) {
    if (item.runId !== runId) continue;
    if (item.type === "run_interrupt_result") unresponsive = false;
    if (item.type === "run_interrupt_request") unresponsive = item.unresponsiveAt !== undefined;
  }
  return unresponsive;
}

/**
 * goat#2338: the thread that created a task Force stops that task's child, only once the child
 * ignored an ordinary Stop. It is the person's Force stop, named for the parent thread.
 */
export const forceStopDelegatedTask = Effect.fn("ThreadManagementService.forceStopDelegatedTask")(
  function* (
    deps: {
      readonly getThreadRecords: Orchestrator.OrchestratorV2Shape["getThreadRecords"];
      readonly getThreadShell: Orchestrator.OrchestratorV2Shape["getThreadShell"];
      readonly forceStop: (
        input: OrchestrationV2ForceStopThreadInput,
        reason: string,
      ) => Effect.Effect<OrchestrationV2ForceStopThreadResult, OrchestrationV2ForceStopThreadError>;
    },
    input: { readonly parentThreadId: ThreadId; readonly taskId: NodeId },
  ) {
    const { subagents } = yield* deps.getThreadRecords(input.parentThreadId, ["subagents"], {
      subagentIds: [input.taskId],
    });
    const task = subagents.find(
      (candidate) =>
        candidate.id === input.taskId &&
        candidate.origin === "app_owned" &&
        candidate.threadId === input.parentThreadId &&
        candidate.promotedAt === undefined,
    );
    if (task === undefined || (task.childThreadId === null && task.remote === undefined))
      return yield* new DelegatedForceStopRefused({
        reason: "not_owner",
        message: `not_owner: task ${input.taskId} is not a delegated task this thread created and still owns; only its parent can force stop it.`,
      });
    if (task.remote !== undefined || task.childThreadId === null)
      return yield* new DelegatedForceStopRefused({
        reason: "remote",
        message: `remote: task ${input.taskId} runs on ${task.remote?.host ?? "another host"}; force stop reaches only local children. Cancel it normally and read it with task.read.`,
      });
    const childThreadId = task.childThreadId;
    const child = yield* deps.getThreadRecords(childThreadId, ["runs", "providerTurns"]);
    const run = latestActiveRun(child);
    const items =
      run === undefined
        ? []
        : (yield* deps.getThreadRecords(childThreadId, ["turnItems"], {
            turnItemRunIds: [run.id],
            turnItemTypes: ["run_interrupt_request", "run_interrupt_result"],
          })).turnItems;
    if (run === undefined || !stopIsUnresponsive(run.id, items))
      return yield* new DelegatedForceStopRefused({
        reason: "not_unresponsive",
        message: `not_unresponsive: task ${input.taskId} has no run whose Stop went unanswered. Cancel it normally first; force only once task.read shows stop.state "unresponsive".`,
      });
    const parent = yield* deps.getThreadShell(input.parentThreadId);
    const parentName = parent?.title
      ? `"${parent.title}" (${input.parentThreadId})`
      : input.parentThreadId;
    const result = yield* deps.forceStop(
      { threadId: childThreadId, runId: run.id },
      `Force stopped by parent thread ${parentName}`,
    );
    return { ...result, childThreadId, runId: run.id };
  },
);
