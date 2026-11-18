import type { OrchestrationV2Subagent } from "@goat/contracts";
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
  heldMember: boolean;
}

export function makeClaudeWorkflowStop(requestedAt: number): ClaudeWorkflowStop {
  return { requestedAt, tools: new Map(), outcome: "pending", heldMember: false };
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
