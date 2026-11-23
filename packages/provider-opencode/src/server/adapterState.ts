import type {
  ModelSelection,
  OrchestrationV2AppThread,
  OrchestrationV2ExecutionNode,
  OrchestrationV2ProviderFailure,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2Subagent,
  OrchestrationV2TurnItem,
  PlanId,
  RuntimeRequestId,
  ThreadId,
} from "@goat/contracts";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import type {
  Part as OpenCodePart,
  PermissionRequest,
  PermissionRuleset,
  QuestionRequest,
  ToolPart,
} from "@opencode-ai/sdk/v2";
import type * as DateTime from "effect/DateTime";
import type * as Deferred from "effect/Deferred";
import type * as Effect from "effect/Effect";
import type { OpenCodePermissionRequestKind } from "./permissionRules.ts";
import type { OpenCodeTurnTokenUsageAccumulator } from "./turnUsage.ts";

export type TerminalTurnStatus = Extract<
  OrchestrationV2ProviderTurn["status"],
  "completed" | "interrupted" | "failed" | "cancelled"
>;

export interface ActiveOpenCodeTurn {
  promptOptions?: { readonly agent?: string; readonly variant?: string; readonly system: string };
  readonly usage: OpenCodeTurnTokenUsageAccumulator;
  readonly isRoot: boolean;
  readonly childCall?: OpenCodeSubagentContext;
  readonly threadId: ThreadId;
  readonly runId: ProviderAdapter.ProviderAdapterV2TurnInput["runId"] | null;
  readonly rootNodeId: ProviderAdapter.ProviderAdapterV2TurnInput["rootNodeId"];
  readonly appThread: OrchestrationV2AppThread;
  readonly modelSelection: ModelSelection;
  readonly runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
  readonly providerTurnId: OrchestrationV2ProviderTurn["id"];
  readonly providerThreadId: OrchestrationV2ProviderTurn["providerThreadId"];
  readonly providerTurnOrdinal: number;
  readonly runOrdinal: number;
  readonly runAttemptId: OrchestrationV2ProviderTurn["runAttemptId"];
  readonly startedAt: DateTime.Utc;
  readonly itemOrdinals: Map<string, number>;
  readonly parts: Map<string, Exclude<OpenCodePart, ToolPart>>;
  readonly partIdsByMessage: Map<string, Set<string>>;
  readonly toolNamesByCallId: Map<string, string>;
  mcpServerNames?: ReadonlyArray<string>;
  readonly providerTurn: OrchestrationV2ProviderTurn;
  nextItemOrdinal: number;
  nativeUserMessageId: string | null;
  admissionMessageId: string | null;
  pendingMemoryReceipt?:
    | { readonly messageId: string; readonly receipt: Effect.Effect<void> }
    | undefined;
  priorWakePromptIds?: Set<string>;
  priorWakeSettled?: Deferred.Deferred<void>;
  interrupted: boolean;
  finalized: boolean;
  contextOverflow: OrchestrationV2ProviderFailure | null;
  planId: PlanId | null;
  admissionGeneration: number;
  admissionReconciliationGeneration: number | null;
  admissionPending: boolean;
  admissionAccepted: boolean;
  admissionMessageObserved: boolean;
  idleDuringAdmission: boolean;
  admissionUncertain: boolean;
  admissionStatusSequence: number;
  admissionSettled: Deferred.Deferred<void>;
  admissionAbortController: AbortController | null;
}

export interface OpenCodeSubagentContext {
  readonly nativeItemId: string;
  readonly nodeId: OrchestrationV2Subagent["id"];
  readonly parentState: OpenCodeThreadState;
  readonly parentTurn: ActiveOpenCodeTurn;
  prompt: string;
  title: string | null;
  readonly startedAt: DateTime.Utc;
  childSessionId: string | null;
  childThreadId: ThreadId | null;
  childProviderThreadId: OrchestrationV2ProviderThread["id"] | null;
  model: string | null;
  result: string | null;
  detached?: boolean;
  launchOutcome?: TerminalTurnStatus;
  childExecution?: OpenCodeChildExecution;
}

export interface OpenCodeChildExecution {
  readonly resumed: boolean;
  awaitingStart: boolean;
  pendingResume?: { outcome?: TerminalTurnStatus };
  outcome?: TerminalTurnStatus | undefined;
}

export interface OpenCodeThreadState {
  readonly nativeSessionId: string;
  providerThread: OrchestrationV2ProviderThread;
  appThread: OrchestrationV2AppThread | null;
  activeTurn: ActiveOpenCodeTurn | null;
  readonly providerTurns: Map<string, OrchestrationV2ProviderTurn>;
  readonly runtimeRequests: Map<string, OrchestrationV2RuntimeRequest>;
  readonly messageRoles: Map<string, "user" | "assistant">;
  readonly userMessageIds: Array<string>;
  parentSubagent: OpenCodeSubagentContext | null;
  // null: a child resumed after a restart, whose next ordinal is recovered from OpenCode.
  nextChildTurnOrdinal: number | null;
  nextAdmissionGeneration: number;
  /** The session's rules as last read or written, and whether their trailing deny is GOAT's. */
  permission: PermissionRuleset;
  metadata: { readonly [key: string]: unknown } | undefined;
  subagentsDenied: boolean;
  permissionRefreshPending?: boolean;
}

export interface OpenCodeRequestOwner {
  readonly state: OpenCodeThreadState;
  readonly turn: ActiveOpenCodeTurn;
  readonly subagent: OpenCodeSubagentContext | null;
}

export function topLevelRequestOwner(state: OpenCodeThreadState): OpenCodeRequestOwner | undefined {
  let owner = state;
  let subagent: OpenCodeSubagentContext | null = null;
  while (owner.parentSubagent !== null) {
    subagent = owner.parentSubagent;
    owner = subagent.parentState;
  }
  return owner.activeTurn === null ? undefined : { state: owner, turn: owner.activeTurn, subagent };
}

export interface PendingOpenCodeRequest {
  readonly requestId: RuntimeRequestId;
  readonly nativeRequestId: string;
  readonly nativeSessionId: string;
  readonly turn: ActiveOpenCodeTurn;
  readonly state: OpenCodeThreadState;
  readonly nodeId: OrchestrationV2ExecutionNode["id"];
  readonly parentNodeId: OrchestrationV2ExecutionNode["id"];
  readonly turnItemId: OrchestrationV2TurnItem["id"];
  readonly requestKind: OpenCodePermissionRequestKind | "user_input";
  readonly createdAt: DateTime.Utc;
  readonly permission?: PermissionRequest;
  readonly question?: QuestionRequest;
}
