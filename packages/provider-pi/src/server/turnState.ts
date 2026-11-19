import type {
  MessageId,
  OrchestrationV2ExecutionNode,
  OrchestrationV2ProviderRef,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2TurnItem,
} from "@goat/contracts";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import type { makeProviderFailure } from "@goat/provider-core/server/failure";
import type * as DateTime from "effect/DateTime";
import type * as Fiber from "effect/Fiber";
import type { PiCompactionState, PiProviderRetryState } from "./compactionTitle.ts";
import type { PiCustomAnswerRoute } from "./extensionDialog.ts";
import type { PiRpcRecord } from "./rpc.ts";

export interface PiStreamItemState {
  readonly nativeItemId: string;
  readonly kind: "assistant_message" | "reasoning";
  text: string;
  completed: boolean;
  flushScheduled: boolean;
  published: boolean;
  readonly startedAt: DateTime.Utc;
}
export interface ActivePiTurn {
  readonly turnInput: ProviderAdapter.ProviderAdapterV2TurnInput;
  readonly providerTurn: OrchestrationV2ProviderTurn;
  readonly startedAt: DateTime.Utc;
  readonly itemOrdinals: Map<string, number>;
  nextItemOrdinal: number;
  messageOrdinal: number;
  readonly streamItems: Map<string, PiStreamItemState>;
  readonly toolArgs: Map<string, unknown>;
  readonly toolStartedAt: Map<string, DateTime.Utc>;
  readonly commandOutputBytes: Map<string, number>;
  interrupted: boolean;
  nativeAborted: boolean;
  sawAgentActivity: boolean;
  adoptedWake: boolean;
  promptMayBeCommandOnly: boolean;
  latestCompactionAfterTokens: number | null;
  lastLiveUsedTokens: number | null;
  settleProbeGeneration: number;
  /** An extension may start compaction immediately after Pi emits agent_settled. */
  settleWhenIdle: boolean;
  compactionCancelled: boolean;
  manualCompactInFlight: boolean;
  activeCompaction: PiCompactionState | null;
  activeProviderRetry: PiProviderRetryState | null;
  failure: ReturnType<typeof makeProviderFailure> | null;
  rejectedPromptFailure: ReturnType<typeof makeProviderFailure> | null;
  /** Steers Pi queued in send order; it reads them at a step boundary, after running tools return. */
  readonly unreadSteers: Array<MessageId>;
  stopTreeRefs?: PiTurnTreeRefs | null;
  /** The provider/model Pi reported on its latest assistant message. */
  reportedModel?: string;
}
export interface PiTurnTreeRefs {
  /** Omitted keeps the synthetic ref; null means the turn left nothing on the active branch. */
  readonly nativeTurnRef: OrchestrationV2ProviderRef | null | undefined;
  readonly leafId: string | null;
  readonly retainedNativeTurnIds: ReadonlyArray<string> | undefined;
}

export interface PendingPiPrompt {
  readonly nativeRequestId: string;
  readonly customAnswerRoute: PiCustomAnswerRoute | undefined;
  readonly method: "select" | "confirm" | "input" | "editor";
  readonly questionId: string;
  readonly approvalKey: string;
  readonly expiresAt: number | null;
  expirationFiber: Fiber.Fiber<void> | null;
  runtimeRequest: OrchestrationV2RuntimeRequest;
  readonly node: OrchestrationV2ExecutionNode;
  readonly turnItem: OrchestrationV2TurnItem;
}

export interface PiPromptSend {
  readonly providerTurnId: OrchestrationV2ProviderTurn["id"];
  readonly kind: "turn_start" | "steer";
  readonly record: PiRpcRecord;
  readonly messageId?: MessageId;
}

export interface PiThreadState {
  readonly supersededSessionFiles: Set<string>;
  providerThread: OrchestrationV2ProviderThread;
  activeTurn: ActivePiTurn | null;
}

export interface PiWake {
  readonly state: PiThreadState;
  readonly events: Array<PiRpcRecord>;
}
