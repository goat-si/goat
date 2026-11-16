import type { makeThreadErrorSetter } from "../ChatView.logic";
import type {
  EnvironmentId,
  ModelSelection,
  ProviderInteractionMode,
  RuntimeMode,
  ScopedThreadRef,
  ThreadId,
} from "@goat/contracts";
import type { CodexFeedbackSubmission } from "@goat/client-runtime/state/threads";
import type { Dispatch, SetStateAction } from "react";
import type { AtomCommandResult } from "@goat/client-runtime/state/runtime";
import type { ChatMessage, SessionPhase } from "../../types";
import type {
  ComposerFileAttachment,
  ComposerImageAttachment,
  ComposerThreadTarget,
  DraftId,
  DraftSessionState,
  DraftThreadEnvMode,
} from "../../composerDraftStore";
import type { TerminalContextDraft } from "../../lib/terminalContext";
import type { EnvironmentProject, EnvironmentThreadShell } from "@goat/client-runtime/state/shell";
import type { ProviderInstanceEntry } from "../../providerInstances";
import type { ComposerHandleRef } from "../../composerHandleContext";
import type { useLogicalProjectEnvironments } from "../../hooks/useLogicalProjectEnvironments";
import type { LatestProposedPlanState } from "../../session-logic";
import type { useDraftEnvironmentRouting } from "./useDraftEnvironmentRouting";
import type { useLocalDispatchState } from "./useLocalDispatchState";
import type { usePendingThreadRequests } from "./usePendingThreadRequests";
import type { useQueuedRunEdit } from "./useQueuedRunEdit";
import type { useTimelineFollow } from "./useTimelineFollow";
import type { useUsageLimitsPanel } from "./useUsageLimitsPanel";
import type { useWorktreeSetup } from "./useWorktreeSetup";
import type { sshThreadHandoffBlockReason } from "../../lib/sshWorktree";
import type { deriveCloudTaskState } from "@goat/client-runtime/state/cloud-task";

type PendingThreadRequests = ReturnType<typeof usePendingThreadRequests>;
type LocalDispatchState = ReturnType<typeof useLocalDispatchState>;
type DraftEnvironmentRouting = ReturnType<typeof useDraftEnvironmentRouting>;
type UsageLimitsPanel = ReturnType<typeof useUsageLimitsPanel>;
type TimelineFollow = ReturnType<typeof useTimelineFollow>;

export interface ComposerSendInput {
  readonly isCloudThread: boolean;
  readonly activeThreadRef: ScopedThreadRef | null;
  readonly environmentId: EnvironmentId;
  readonly routeThreadRef: ScopedThreadRef;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly cloudState: ReturnType<typeof deriveCloudTaskState>;
  readonly sideChatAvailable: boolean;
  /** GOAT: what decides whether this thread can continue on a saved SSH host. */
  readonly sshHandoffGuard: Omit<
    Parameters<typeof sshThreadHandoffBlockReason>[0],
    "sourceThreadAvailable" | "hasMessages" | "runs" | "catalogReady" | "options" | "canLaunch"
  >;
  readonly routeThreadKey: string;
  readonly currentRouteThreadKeyRef: { readonly current: string | null };
  readonly draftId: DraftId | null;
  readonly draftThread: DraftSessionState | null;
  readonly activeThread: EnvironmentThreadShell | undefined;
  readonly activeThreadKey: string | null;
  readonly activeThreadBranch: string | null;
  readonly activeProject: EnvironmentProject | null;
  readonly activeProjectDefaultModelSelection: ModelSelection | null;
  readonly activeProposedPlan: LatestProposedPlanState | null;
  readonly activeMessageCount: number;
  readonly isServerThread: boolean;
  readonly isLocalDraftThread: boolean;
  readonly isGitRepo: boolean;
  readonly phase: SessionPhase;
  readonly runtimeMode: RuntimeMode;
  readonly sendEnvMode: DraftThreadEnvMode;
  readonly startFromOrigin: boolean;
  readonly localCheckoutBranchMismatch: {
    readonly threadBranch: string;
    readonly currentBranch: string;
  } | null;
  readonly logicalProjectEnvironments: ReturnType<typeof useLogicalProjectEnvironments>;
  readonly providerInstanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly composerRef: ComposerHandleRef;
  readonly composerDraftTarget: ComposerThreadTarget;
  readonly promptRef: { current: string };
  readonly composerImagesRef: { current: ComposerImageAttachment[] };
  readonly composerFilesRef: { current: ComposerFileAttachment[] };
  readonly composerTerminalContextsRef: { current: TerminalContextDraft[] };
  readonly feedbackUploadsInFlightRef: { readonly current: Set<string> };
  readonly queuedRunEdit: ReturnType<typeof useQueuedRunEdit>;
  readonly isConnecting: boolean;
  readonly isRevertingCheckpoint: boolean;
  readonly threadDetailLoading: boolean;
  readonly activeEnvironmentUnavailable: boolean;
  readonly isSendBusy: boolean;
  readonly sendQueuesBehindSetup: boolean;
  readonly isDraftHeroState: boolean;
  readonly panelAnimationsActive: boolean;
  readonly panelAnimationDurationMs: number;
  readonly keepFullHistory: boolean;
  readonly resumeCompactionTokens: number | null;
  readonly showPlanFollowUpPrompt: boolean;
  readonly usageLimitsKey: string | null;
  readonly usageLimitsOffered: boolean;
  readonly openUsageLimits: UsageLimitsPanel["open"];
  readonly clearUsageLimitsFor: UsageLimitsPanel["clearFor"];
  readonly needsLoadBalancing: boolean;
  readonly loadBalancing: DraftEnvironmentRouting["loadBalancing"];
  readonly refreshBeforeSend: DraftEnvironmentRouting["refreshBeforeSend"];
  readonly readPendingEnvironmentChange: DraftEnvironmentRouting["readPendingEnvironmentChange"];
  readonly pendingApprovals: PendingThreadRequests["pendingApprovals"];
  readonly respondingRequestIds: PendingThreadRequests["respondingRequestIds"];
  readonly activePendingProgress: PendingThreadRequests["activePendingProgress"];
  readonly onAdvanceActivePendingUserInput: PendingThreadRequests["onAdvanceActivePendingUserInput"];
  readonly onChangeActivePendingUserInputCustomAnswer: PendingThreadRequests["onChangeActivePendingUserInputCustomAnswer"];
  readonly onRespondToApproval: PendingThreadRequests["onRespondToApproval"];
  readonly beginLocalDispatch: LocalDispatchState["beginLocalDispatch"];
  readonly resetLocalDispatch: LocalDispatchState["resetLocalDispatch"];
  readonly beginWorktreeSetup: ReturnType<typeof useWorktreeSetup>["begin"];
  readonly captureDraftHeroComposerRect: () => void;
  readonly setDockedDraftHeroThreadKey: Dispatch<SetStateAction<string | null>>;
  readonly setSetupQueueSendThreadKey: Dispatch<SetStateAction<string | null>>;
  readonly setOptimisticUserMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  readonly optimisticBlobPreviews: {
    readonly track: (message: ChatMessage) => void;
    readonly release: (message: ChatMessage) => void;
  };
  readonly setFeedbackSubmissionsByThreadKey: Dispatch<
    SetStateAction<Record<string, ReadonlyArray<CodexFeedbackSubmission>>>
  >;
  readonly setThreadError: ReturnType<typeof makeThreadErrorSetter>;
  readonly setKeepFullHistory: (threadKey: string, keep: boolean) => void;
  readonly anchorNewTurn: TimelineFollow["anchorNewTurn"];
  readonly acknowledgeActiveThreadWoke: () => void;
  readonly handleInteractionModeChange: (mode: ProviderInteractionMode) => void;
  readonly handleNewThreadInActiveProject: () => void;
  readonly persistThreadSettingsForNextTurn: (input: {
    threadId: ThreadId;
    createdAt: string;
    branch?: string;
    runtimeMode: RuntimeMode;
    interactionMode: ProviderInteractionMode;
  }) => Promise<AtomCommandResult<void, unknown>>;
}
