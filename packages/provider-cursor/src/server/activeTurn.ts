import type { InteractionUpdate, ToolCall } from "@cursor/sdk";
import type {
  OrchestrationV2ExecutionNode,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  OrchestrationV2Subagent,
  OrchestrationV2TurnItem,
  ThreadId,
} from "@goat/contracts";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import type * as DateTime from "effect/DateTime";
import type * as Deferred from "effect/Deferred";
import type * as CursorAgentSdk from "./CursorAgentSdk.ts";
import type { CursorRunPrompt } from "./steerPrompt.ts";
import type { CursorTransportFailure } from "./transportFailure.ts";

export interface CursorProjectionTarget {
  readonly threadId: ThreadId;
  readonly runId: ProviderAdapter.ProviderAdapterV2TurnInput["runId"] | null;
  readonly rootNodeId: OrchestrationV2ExecutionNode["rootNodeId"];
  readonly parentNodeId: OrchestrationV2ExecutionNode["id"];
  readonly providerThreadId: OrchestrationV2ProviderThread["id"] | null;
  readonly providerTurnId: OrchestrationV2ProviderTurn["id"] | null;
}

export interface ActiveCursorToolCall {
  readonly callId: string;
  toolCall: ToolCall;
  readonly target: CursorProjectionTarget;
  readonly ordinal: number;
  readonly startedAt: DateTime.Utc;
  streamedOutput: string;
}

export interface ActiveCursorSubagent {
  task: OrchestrationV2Subagent;
  toolCall: Extract<ToolCall, { readonly type: "task" }>;
  readonly callId: string;
  readonly childThreadId: ThreadId;
  readonly childRootNodeId: OrchestrationV2ExecutionNode["id"];
  readonly turnItemId: OrchestrationV2TurnItem["id"];
  readonly turnItemOrdinal: number;
  nextChildOrdinal: number;
  resultProjected: boolean;
}

export interface ActiveCursorTextSegment {
  readonly nativeItemId: string;
  readonly startedAt: DateTime.Utc;
  text: string;
}

export interface ActiveCursorTextStream {
  current: ActiveCursorTextSegment | null;
  nextSegment: number;
}

export interface ActiveCursorTurn {
  readonly input: ProviderAdapter.ProviderAdapterV2TurnInput;
  readonly run: CursorAgentSdk.CursorAgentSdkRun;
  readonly providerTurnId: OrchestrationV2ProviderTurn["id"];
  readonly startedAt: DateTime.Utc;
  readonly completed: Deferred.Deferred<void, never>;
  readonly itemOrdinals: Map<string, number>;
  readonly tools: Map<string, ActiveCursorToolCall>;
  readonly subagents: Map<string, ActiveCursorSubagent>;
  readonly assistant: ActiveCursorTextStream;
  assistantReply: CursorTransportFailure;
  readonly reasoning: ActiveCursorTextStream;
  /** The user text this run sent, before GOAT and runtime instructions; absent for /compress. */
  readonly prompt: CursorRunPrompt | undefined;
  interrupted: boolean;
  finalized: boolean;
  /** The agent's latest turn ended and no new work has started since. */
  turnEnded: boolean;
  readonly session: CursorAgentSdk.CursorAgentSdkSession;
  /** What Cursor billed for this run, summed over its turn-ended updates. */
  usage: CursorTurnUsage | undefined;
}

export type CursorTurnUsage = NonNullable<
  Extract<InteractionUpdate, { type: "turn-ended" }>["usage"]
>;

export const addCursorTurnUsage = (
  total: CursorTurnUsage | undefined,
  usage: CursorTurnUsage,
): CursorTurnUsage => {
  if (total === undefined) return usage;
  const reasoningTokens =
    total.reasoningTokens === undefined && usage.reasoningTokens === undefined
      ? undefined
      : (total.reasoningTokens ?? 0) + (usage.reasoningTokens ?? 0);
  return {
    inputTokens: total.inputTokens + usage.inputTokens,
    outputTokens: total.outputTokens + usage.outputTokens,
    cacheReadTokens: total.cacheReadTokens + usage.cacheReadTokens,
    cacheWriteTokens: total.cacheWriteTokens + usage.cacheWriteTokens,
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  };
};
