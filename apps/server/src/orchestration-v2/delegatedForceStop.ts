import {
  type NodeId,
  OrchestrationV2ForceStopThreadError,
  type OrchestrationV2ForceStopThreadInput,
  type OrchestrationV2ForceStopThreadResult,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  type RunId,
  type ThreadId,
} from "@goat/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import type * as Orchestrator from "./Orchestrator.ts";
import { PARENT_FORCE_STOP_PREFIX } from "./runTerminationCause.ts";
import { isActiveRun, latestActiveRun } from "./ThreadManagementService.ts";

/** Why a Force stop an agent or another machine asked for was refused; nothing was stopped. */
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

interface ForceStopDeps {
  readonly getThreadRecords: Orchestrator.OrchestratorV2Shape["getThreadRecords"];
  readonly forceStop: (
    input: OrchestrationV2ForceStopThreadInput,
    reason: string,
    /** Runs under the thread lock before anything stops; its failure refuses the force. */
    recheck?: (target: OrchestrationV2Run | undefined) => Effect.Effect<void, Error>,
  ) => Effect.Effect<OrchestrationV2ForceStopThreadResult, OrchestrationV2ForceStopThreadError>;
}

/**
 * The person's Force stop, run for someone else (goat#2338) and only on a run that ignored an
 * ordinary Stop. `runId`, when given, must still be the thread's live run.
 */
export const forceStopUnresponsiveRun = Effect.fn(
  "ThreadManagementService.forceStopUnresponsiveRun",
)(function* (
  deps: ForceStopDeps,
  input: {
    readonly threadId: ThreadId;
    readonly runId?: RunId | undefined;
    readonly reason: string;
    readonly subject: string;
  },
) {
  const run = latestActiveRun(yield* deps.getThreadRecords(input.threadId, ["runs"]));
  if (input.runId !== undefined && run !== undefined && run.id !== input.runId)
    return yield* new OrchestrationV2ForceStopThreadError({
      threadId: input.threadId,
      reason: "superseded",
    });
  const refused = new DelegatedForceStopRefused({
    reason: "not_unresponsive",
    message: `not_unresponsive: ${input.subject} has no run whose Stop went unanswered. Cancel it normally first; force only once its stop.state is "unresponsive".`,
  });
  const unresponsive = (target: OrchestrationV2Run | undefined) =>
    target === undefined || !isActiveRun(target)
      ? Effect.fail(refused)
      : deps
          .getThreadRecords(input.threadId, ["turnItems"], {
            turnItemRunIds: [target.id],
            turnItemTypes: ["run_interrupt_request", "run_interrupt_result"],
          })
          .pipe(
            Effect.flatMap(({ turnItems }) =>
              stopIsUnresponsive(target.id, turnItems) ? Effect.void : Effect.fail(refused),
            ),
          );
  if (run === undefined) return yield* refused;
  yield* unresponsive(run);
  // The provider may confirm the Stop before the lock is taken; then nothing is touched.
  const result = yield* deps
    .forceStop({ threadId: input.threadId, runId: run.id }, input.reason, unresponsive)
    .pipe(
      Effect.mapError((error) =>
        error.cause instanceof DelegatedForceStopRefused ? error.cause : error,
      ),
    );
  return { ...result, runId: run.id };
});

/**
 * goat#2338: the thread that created a local task Force stops that task's child, only once the
 * child ignored an ordinary Stop. Remote children go through their host (remoteTaskForceStop.ts).
 */
export const forceStopDelegatedTask = Effect.fn("ThreadManagementService.forceStopDelegatedTask")(
  function* (
    deps: ForceStopDeps & {
      readonly getThreadShell: Orchestrator.OrchestratorV2Shape["getThreadShell"];
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
        message: `remote: task ${input.taskId} runs on ${task.remote?.host ?? "another host"}, so its host must force stop it.`,
      });
    const childThreadId = task.childThreadId;
    const parent = yield* deps.getThreadShell(input.parentThreadId);
    // A person reads this; the id stands in only for a parent without a title.
    const parentName = parent?.title ? `"${parent.title}"` : input.parentThreadId;
    const result = yield* forceStopUnresponsiveRun(deps, {
      threadId: childThreadId,
      reason: `${PARENT_FORCE_STOP_PREFIX}${parentName}`,
      subject: `task ${input.taskId}`,
    });
    return { ...result, childThreadId };
  },
);
