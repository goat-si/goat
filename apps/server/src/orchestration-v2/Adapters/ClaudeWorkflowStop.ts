import type {
  OrchestrationV2Subagent,
  OrchestrationV2SubagentWorkflow,
  OrchestrationV2WorkflowAgent,
} from "@goat/contracts";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type { WorkflowAgentMetadata } from "../workflowAgentAnswers.ts";
import type { WorkflowAgentTranscriptCursor } from "../workflowAgentTranscript.ts";

const MAX_HELD_DENIALS = 64;
type SettleDenial = (stopped: boolean) => Effect.Effect<void>;

export interface ClaudeWorkflowStop {
  readonly requestedAt: number;
  readonly tools: Map<string, SettleDenial>;
  outcome: "pending" | "accepted" | "rejected";
  readonly members: Map<number, OrchestrationV2WorkflowAgent>;
}

export function makeClaudeWorkflowStop(requestedAt: number): ClaudeWorkflowStop {
  return { requestedAt, tools: new Map(), outcome: "pending", members: new Map() };
}

export function holdClaudeStopDenial(
  stop: ClaudeWorkflowStop,
  key: string,
  settle: SettleDenial,
): boolean {
  if (stop.outcome !== "pending" || stop.tools.size >= MAX_HELD_DENIALS) return false;
  stop.tools.set(key, settle);
  return true;
}

export const settleClaudeStopDenials = Effect.fn("ClaudeWorkflowStop.settleDenials")(function* (
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

export function workflowWithResolvedClaudeStop(
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
