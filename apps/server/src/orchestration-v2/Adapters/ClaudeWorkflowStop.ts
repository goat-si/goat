import type {
  OrchestrationV2Subagent,
  OrchestrationV2SubagentWorkflow,
  OrchestrationV2WorkflowAgent,
} from "@goat/contracts";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import type * as Scope from "effect/Scope";
import type { WorkflowAgentMetadata } from "../workflowAgentAnswers.ts";
import type { WorkflowAgentTranscriptCursor } from "../workflowAgentTranscript.ts";

import type { ClaudeAgentSdkQuerySession } from "./ClaudeAgentSdkQueryRunner.ts";

const MAX_HELD_DENIALS = 64;
type SettleDenial = (stopped: boolean) => Effect.Effect<void>;

export interface ClaudeWorkflowStop {
  readonly requestedAt: number;
  readonly owner: ClaudeAgentSdkQuerySession;
  acknowledged: boolean;
  waitInterrupted: boolean;
  readonly tools: Map<string, SettleDenial>;
  outcome: "pending" | "accepted" | "rejected";
  readonly members: Map<number, OrchestrationV2WorkflowAgent>;
}

export function makeClaudeWorkflowStop(
  owner: ClaudeAgentSdkQuerySession,
  requestedAt: number,
): ClaudeWorkflowStop {
  return {
    owner,
    requestedAt,
    acknowledged: false,
    waitInterrupted: false,
    tools: new Map(),
    outcome: "pending",
    members: new Map(),
  };
}

export const requestClaudeWorkflowStop = Effect.fn("ClaudeWorkflowStop.request")(function* (
  stop: ClaudeWorkflowStop,
  taskId: string,
  closed: Deferred.Deferred<void>,
  sessionScope: Scope.Scope,
  reconcile: (confirmedOnly: boolean) => Effect.Effect<void>,
) {
  yield* Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      // The RPC only waits for the reply. The native request can still answer after its deadline.
      const noWaiter = yield* Deferred.make<void>();
      const retireRequest = Deferred.await(noWaiter).pipe(
        Effect.andThen(Deferred.await(closed)),
        Effect.andThen(Effect.interrupt),
      );
      const request = yield* stop.owner.stopTask(taskId).pipe(
        Effect.raceFirst(retireRequest),
        Effect.onExit((exit) => {
          if (Exit.hasInterrupts(exit)) return Effect.void;
          stop.acknowledged = Exit.isSuccess(exit);
          return reconcile(false);
        }),
        Effect.forkIn(sessionScope, { uninterruptible: false }),
      );
      yield* restore(Fiber.join(request)).pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            stop.waitInterrupted = true;
          }).pipe(
            Effect.andThen(Deferred.succeed(noWaiter, undefined)),
            Effect.andThen(reconcile(true)),
          ),
        ),
      );
    }),
  );
});

export function holdClaudeStopDenial(
  stop: ClaudeWorkflowStop,
  key: string,
  settle: SettleDenial,
): boolean {
  if (stop.outcome !== "pending" || stop.tools.size >= MAX_HELD_DENIALS) return false;
  stop.tools.set(key, settle);
  return true;
}

const settleClaudeStopDenials = Effect.fn("ClaudeWorkflowStop.settleDenials")(function* (
  stop: ClaudeWorkflowStop,
  accepted: boolean,
) {
  stop.outcome = accepted ? "accepted" : "rejected";
  for (const settle of stop.tools.values()) yield* settle(accepted);
  stop.tools.clear();
});

export function holdClaudeWorkflowMember(
  stop: ClaudeWorkflowStop,
  member: OrchestrationV2WorkflowAgent,
  previousStatus: OrchestrationV2Subagent["status"],
): OrchestrationV2WorkflowAgent {
  stop.members.set(member.index, member);
  const { result: _result, completedAt: _completedAt, ...active } = member;
  return { ...active, state: previousStatus === "pending" ? "queued" : "running" };
}

function workflowWithResolvedClaudeStop(
  workflow: OrchestrationV2SubagentWorkflow,
  stop: ClaudeWorkflowStop,
): OrchestrationV2SubagentWorkflow {
  const agents = workflow.agents.map((member) => {
    const held = stop.members.get(member.index);
    return held?.agentId === member.agentId &&
      held !== undefined &&
      (held.attempt ?? 1) === (member.attempt ?? 1)
      ? held
      : member;
  });
  stop.members.clear();
  return { ...workflow, agents };
}

export const reconcileClaudeWorkflowStop = Effect.fn("ClaudeWorkflowStop.reconcile")(function* <
  C extends {
    task: OrchestrationV2Subagent;
    workflowStop?: ClaudeWorkflowStop;
    confirmedOutcome: { readonly status: OrchestrationV2Subagent["status"] } | undefined;
  },
>(
  coordinator: C,
  stop: ClaudeWorkflowStop,
  project: (input: {
    coordinator: C;
    workflow: OrchestrationV2SubagentWorkflow;
  }) => Effect.Effect<void>,
) {
  if (coordinator.workflowStop !== stop || stop.outcome !== "pending") return;
  yield* settleClaudeStopDenials(
    stop,
    stop.acknowledged || coordinator.confirmedOutcome?.status === "cancelled",
  );
  if (stop.members.size > 0 && coordinator.task.workflow !== undefined) {
    yield* project({
      coordinator,
      workflow: workflowWithResolvedClaudeStop(coordinator.task.workflow, stop),
    });
  }
});

export function beforeClaudeStopProjection(
  task: OrchestrationV2Subagent,
  stop: ClaudeWorkflowStop | undefined,
  previous: OrchestrationV2SubagentWorkflow | undefined,
): OrchestrationV2Subagent {
  return stop === undefined || previous === undefined ? task : { ...task, workflow: previous };
}

export interface ClaudeWorkflowMemberState<ToolCall> {
  readonly status: OrchestrationV2Subagent["status"];
  readonly attempt: number;
  readonly transcriptReadAttempts: number;
  readonly agentId: string | undefined;
  readonly transcriptCursor: WorkflowAgentTranscriptCursor;
  readonly transcriptMetadata: WorkflowAgentMetadata | undefined;
  readonly observedWorkflowStop: ClaudeWorkflowStop | undefined;
  readonly nextItemOrdinal: number;
  readonly toolCalls: Map<string, ToolCall>;
  readonly textShown: boolean;
  readonly turnEnded: boolean;
  readonly resultShown: boolean;
  readonly result: string | undefined;
  readonly label: string;
  readonly prompt: string;
  readonly model: string;
  readonly createdAt: DateTime.Utc;
  readonly startedAt: DateTime.Utc | null;
  readonly completedAt: DateTime.Utc | null;
}
