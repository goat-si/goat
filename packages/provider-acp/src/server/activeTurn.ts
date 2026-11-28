import { acpSubagentStatusBlocksTurnSettlement } from "./acpSubagentStatus.ts";
import type {
  OrchestrationV2ProviderTurn,
  OrchestrationV2ProviderFailure,
  OrchestrationV2ProviderRetry,
  ThreadTokenUsageSnapshot,
  OrchestrationV2ProviderThreadNativeMetadata,
  OrchestrationV2PlanArtifact,
  OrchestrationV2Subagent,
  ThreadId,
  OrchestrationV2ExecutionNode,
  OrchestrationV2TurnItem,
  ProviderThreadId,
} from "@goat/contracts";
import type {
  RuntimeRequestId,
  OrchestrationV2RuntimeRequest,
  ProviderApprovalDecision,
  ProviderUserInputAnswers,
} from "@goat/contracts";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import type * as DateTime from "effect/DateTime";
import type * as Deferred from "effect/Deferred";
import type * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import type * as Semaphore from "effect/Semaphore";
import type * as EffectAcpSchema from "effect-acp/compat";
import type { AcpToolCallState } from "./runtimeModel.ts";
import type { AcpSubagentTranscriptEntry } from "./subagentTranscript.ts";

export interface ActiveTextSegment {
  readonly nativeItemId: string;
  readonly startedAt: DateTime.Utc;
  sourceMessageId: string | null;
  text: string;
  // The running node and first text have been emitted.
  emitted: boolean;
  // Text changed since the last emission; a delayed flush is scheduled.
  dirty: boolean;
}

export interface ActiveTextStream {
  current: ActiveTextSegment | null;
  nextSegment: number;
  /** Closed messages a later chunk can resume, oldest first, up to MAX_RESUMABLE_TEXT_SEGMENTS. */
  readonly closedNamedSegments: Map<string, ActiveTextSegment>;
}

// A message resumed after this many newer named messages closed starts over from its new text.
export const MAX_RESUMABLE_TEXT_SEGMENTS = 64;

export interface AcpNativeBuildConfiguration {
  readonly modeId?: string;
  readonly configOptions: ReadonlyArray<{ readonly id: string; readonly value: string }>;
}

export interface ActiveAcpTurn {
  readonly input: ProviderAdapter.ProviderAdapterV2TurnInput;
  readonly providerTurnId: OrchestrationV2ProviderTurn["id"];
  readonly nativeThreadId: string;
  readonly nativeTurnId: string;
  readonly startedAt: DateTime.Utc;
  readonly completed: Deferred.Deferred<void, never>;
  readonly itemOrdinals: Map<string, number>;
  readonly outgoingPrompt?: ReadonlyArray<EffectAcpSchema.ContentBlock> | undefined;
  appContextCommit?: (() => boolean) | undefined;
  consumedPromptMessageId?: string;
  readonly user: ActiveTextStream;
  readonly assistant: ActiveTextStream;
  backgroundReportMessage?: { messageId: string | null; text: string } | undefined;
  readonly reasoning: ActiveTextStream;
  providerRetry?:
    | {
        readonly failure: OrchestrationV2ProviderFailure;
        readonly retry: OrchestrationV2ProviderRetry;
        readonly startedAt: DateTime.Utc;
        readonly itemOrdinal: number;
      }
    | undefined;
  contextUsage: ThreadTokenUsageSnapshot | null;
  nativeMetadata: OrchestrationV2ProviderThreadNativeMetadata | null;
  readonly tools: Map<string, AcpToolCallState & { readonly backgroundCommandTaskId?: string }>;
  readonly toolUpdatesSkipped: Map<string, number>;
  readonly toolStartedAt: Map<string, DateTime.Utc>;
  readonly subagents: Map<string, ActiveAcpSubagent>;
  readonly subagentsBySessionId: Map<string, ActiveAcpSubagent>;
  readonly pendingSubagentNotifications: Map<string, Array<EffectAcpSchema.SessionNotification>>;
  readonly toolCallIdsByBackgroundTaskId: Map<string, string>;
  /** Command ACKs register null; terminal results wait here for prompt settlement. */
  readonly backgroundCommands: Map<
    string,
    { readonly status: "completed" | "failed"; readonly output?: string } | null
  >;
  readonly persistentBackgroundTaskIds: Set<string>;
  /** Monitor end notices lack output; wait for hydration or the safety timeout. */
  readonly awaitingBackgroundHydration: Set<string>;
  readonly pendingInjectedReport: Set<string>;
  /** Reports can precede monitor end notices; consume their completion marker without re-arming. */
  earlyInjectedReportObserved: boolean;
  readonly plans: Map<
    string,
    {
      readonly id: OrchestrationV2PlanArtifact["id"];
      readonly startedAt: DateTime.Utc;
      /** The turn that first reported the plan; later turns update its rows. */
      readonly origin: {
        readonly runId: ActiveAcpTurn["input"]["runId"];
        readonly rootNodeId: ActiveAcpTurn["input"]["rootNodeId"];
        readonly providerThreadId: ActiveAcpTurn["input"]["providerThread"]["id"];
        readonly providerTurnId: ActiveAcpTurn["providerTurnId"];
        readonly nativeItemId: string;
        readonly ordinal: number;
      };
      latest: OrchestrationV2PlanArtifact | null;
    }
  >;
  interrupted: boolean;
  finalized: boolean;
  finalizedStatus: "completed" | "interrupted" | "failed" | "cancelled" | null;
  promptSettled: boolean;
  promptSettledStatus: "completed" | "interrupted" | "failed" | "cancelled" | null;
  workAccepted: boolean;
  /** Settles with the turn's latest prompt; a prompt-steer replaces a settled one. */
  promptWireSettled: Deferred.Deferred<void, never>;
  /** Counts the turn's prompts; only the latest one settles the turn. */
  promptSequence: number;
  /** The turn already resent a prompt after a resumable outcome failure. */
  outcomeResumed: boolean;
  promptUsage: EffectAcpSchema.Usage | undefined;
  backgroundFinalizeGeneration: number;
  replyOpen: boolean;
  lastProgressAt: number;
  inactivityWatchdog: Fiber.Fiber<void> | undefined;
  readonly promptDispatched: Deferred.Deferred<void>;
  confirmMemory?: Effect.Effect<void>;
  /** Frees the runtime for the next prompt while the agent still holds this one's response. */
  foregroundIdle: Deferred.Deferred<void>;
}

export type AcpRuntimeTeardownState =
  | { readonly _tag: "Idle" }
  | {
      readonly _tag: "InProgress";
      readonly completed: Deferred.Deferred<void, ProviderAdapter.ProviderAdapterProtocolError>;
    }
  | { readonly _tag: "Failed"; readonly error: ProviderAdapter.ProviderAdapterProtocolError };

export interface ActiveAcpSubagent {
  task: OrchestrationV2Subagent;
  readonly rootSessionId: string;
  readonly childThreadId: ThreadId;
  readonly childRootNodeId: OrchestrationV2ExecutionNode["id"];
  readonly turnItemId: OrchestrationV2TurnItem["id"];
  turnItemOrdinal: number;
  providerTurnId: OrchestrationV2ProviderTurn["id"];
  readonly parentProviderThreadId: ProviderThreadId;
  childSessionId: string | null;
  assistantText: string;
  readonly assistantMessages: Map<string, string>;
  // Messages whose latest text waits for a delayed flush.
  readonly pendingAssistantMessages: Set<string>;
  assistantFlushScheduled: boolean;
  readonly childItemOrdinals: Map<string, number>;
  nextChildOrdinal: number;
  terminalStatusProjected: boolean;
  readonly toolState: Pick<ActiveAcpTurn, "tools" | "toolUpdatesSkipped" | "toolStartedAt">;
  // ACP has no interrupted tool status; keep forced interruption across late updates.
  readonly interruptedToolIds: Set<string>;
  readonly toolSessionIds: Map<string, string>;
  readonly transcriptEntryFingerprints: Map<string, string>;
  readonly transcriptStartedAt: Map<string, DateTime.Utc>;
  readonly transcriptOpenEntries: Map<string, AcpSubagentTranscriptEntry>;
  readonly lastTranscriptEntryKinds: Map<string, AcpSubagentTranscriptEntry["kind"]>;
  readonly transcriptDrainPermit: Semaphore.Semaphore;
  transcriptFollowerStop: Deferred.Deferred<void> | undefined;
  transcriptFollowerStarted: boolean;
  transcriptTrailingDrainStop: Deferred.Deferred<void> | undefined;
  transcriptTrailingDrainStarted: boolean;
}

export interface AcpNativeChildSession {
  parentSessionId: string | null;
  status: "running" | "completed" | "failed" | "cancelled";
  result: string | null;
  delegationId: string | null;
  prompt: string;
  subagent: ActiveAcpSubagent | undefined;
  owner: ActiveAcpTurn | undefined;
  readonly pending: Array<EffectAcpSchema.SessionNotification>;
}

export type AcpCarryoverSubagents = {
  readonly sessionId: string;
  /** The root's subscriber keeps ingesting, so late child terminals can still project. */
  readonly projectsLateTerminals: boolean;
  readonly subagents: ReadonlyArray<ActiveAcpSubagent>;
};

export type PendingRuntimeRequest = {
  readonly generation: number;
  readonly nativeResponseAcknowledgement: Deferred.Deferred<void, EffectAcpErrors.AcpError>;
  readonly transportRequestId: string;
  readonly requestId: RuntimeRequestId;
  readonly runtimeRequest: OrchestrationV2RuntimeRequest;
  readonly node: OrchestrationV2ExecutionNode;
  readonly turnItem: OrchestrationV2TurnItem;
} & (
  | {
      readonly type: "approval";
      readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
    }
  | {
      readonly type: "user_input";
      readonly answers: Deferred.Deferred<ProviderUserInputAnswers | null>;
    }
);

export function acpSubagentHasPendingBackgroundWork(subagent: ActiveAcpSubagent): boolean {
  return (
    acpSubagentStatusBlocksTurnSettlement(subagent.task.status) || !subagent.terminalStatusProjected
  );
}
