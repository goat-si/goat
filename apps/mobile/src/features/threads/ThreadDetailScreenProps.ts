import type { CloudRunCard, CloudTaskState } from "@goat/client-runtime/state/cloud-task";
import type { WorktreeSetupCardProps } from "./worktree-setup-card";
import type { ComposerTextPaste } from "../../native/GoatComposerEditor.types";
import type { EnvironmentConnectionPhase } from "@goat/client-runtime/connection";
import type { EnvironmentThreadShell } from "@goat/client-runtime/state/shell";
import type { HandoffEndpoints } from "@goat/client-runtime/handoff";
import type { CodexFeedbackSubmission } from "@goat/client-runtime/state/threads";
import type {
  OrchestrationV2ProviderSession,
  EnvironmentId,
  MessageId,
  ModelSelection,
  ProviderInteractionMode,
  RuntimeMode,
  RuntimeRequestId,
  ScopedThreadRef,
  ServerConfig as GoatServerConfig,
} from "@goat/contracts";
import type {
  ApprovalResponder,
  ThreadUserInputQuestion,
} from "@goat/client-runtime/state/thread-requests";
import type { ProviderSubagentStatus } from "@goat/client-runtime/state/thread-execution";
import type { QueuedRunEdit } from "../../state/queued-run-edit";
import type { FollowUpBehavior } from "../../lib/followUpBehavior";
import type { ActiveTurnComposerAction } from "@goat/client-runtime/state/composer-dispatch";
import type { ComposerEditorHandle } from "../../components/ComposerEditor";
import type { StatusTone } from "../../components/StatusPill";
import type { LayoutVariant } from "../../lib/layout";
import type { QueuedThreadMessage } from "../../state/thread-outbox-model";
import type {
  PendingApproval,
  PendingUserInput,
  PendingUserInputDraftAnswer,
  ThreadFeedEntry,
  ThreadFeedLatestRun,
} from "../../lib/threadActivity";
import type { CompactBeforeSendState } from "./CompactBeforeSendNotice";
import type { ThreadFeedHistoryControls } from "./ThreadFeed";
import type { ThreadContentPresentation } from "./threadContentPresentation";
import type { RedirectBeforeDispatch } from "../../state/redirectSettings";

export interface ThreadDetailScreenProps {
  readonly cloudState: CloudTaskState;
  readonly cloudRun?: CloudRunCard | null;
  readonly onRetryCloudRun?: (() => void) | null;
  readonly draftMode?: {
    readonly content: (
      headerInset: number,
      bottomInset: number,
      availableHeight: number,
    ) => React.ReactNode;
    readonly controls: (viewportHeight: number) => React.ReactNode;
    readonly editorRef: React.RefObject<ComposerEditorHandle | null>;
    readonly sendBlockedReason: string | null;
    readonly interactionLocked: boolean;
  };
  readonly worktreeSetup?: WorktreeSetupCardProps | null;
  readonly worktreeSetupDetails?: WorktreeSetupCardProps | null;
  readonly canOperateThread: boolean;
  readonly selectedThread: EnvironmentThreadShell;
  /** Use this for detail reads; it stays null until queued creation reaches the server. */
  readonly selectedThreadDetailRef: ScopedThreadRef | null;
  readonly contentPresentation: ThreadContentPresentation;
  readonly screenTone: StatusTone;
  readonly connectionError: string | null;
  readonly environmentLabel: string | null;
  readonly feedbackSubmissions: ReadonlyArray<CodexFeedbackSubmission>;
  readonly onDismissFeedback: (id: MessageId) => void;
  readonly selectedThreadFeed: ReadonlyArray<ThreadFeedEntry>;
  readonly pendingHandoff?: HandoffEndpoints | null;
  readonly activityRun:
    | (ThreadFeedLatestRun & { readonly survivingRestartNotice?: string | null })
    | null;
  readonly activeWorkStartedAt: string | null;
  readonly runlessWorkActive?: boolean;
  readonly providerSubagentStatus?: ProviderSubagentStatus | null;
  readonly extensionStatuses?: NonNullable<OrchestrationV2ProviderSession["extensionStatuses"]>;
  readonly isCompacting: boolean;
  /** Set while the next send compacts the thread first. */
  readonly compactBeforeSend?: CompactBeforeSendState | null;
  readonly creationState:
    | {
        readonly kind: "preparing";
        readonly preparingWorktree: boolean;
        readonly serverOwned: boolean;
      }
    | { readonly kind: "failed"; readonly reason: string; readonly onEditTask: () => void }
    | null;
  readonly activePendingApproval: PendingApproval | null;
  readonly activePendingApprovals: ReadonlyArray<PendingApproval>;
  readonly respondingApprovalId: RuntimeRequestId | null;
  readonly activePendingUserInput: PendingUserInput | null;
  readonly activePendingUserInputDrafts: Record<string, PendingUserInputDraftAnswer>;
  readonly activePendingUserInputAnswers: Record<string, string | ReadonlyArray<string>> | null;
  readonly respondingUserInputId: RuntimeRequestId | null;
  readonly connectionStateLabel: EnvironmentConnectionPhase;
  readonly historyControls?: ThreadFeedHistoryControls;
  readonly activeThreadBusy: boolean;
  readonly canStopThread: boolean;
  readonly queuedRunEdit: QueuedRunEdit | null;
  readonly composerDraftKey: string | null;
  readonly followUpBehavior: FollowUpBehavior;
  readonly canSteerActiveTurn: boolean;
  readonly isSavingQueuedEdit: boolean;
  readonly onCancelQueuedRunEdit: () => void;
  readonly onRemoveQueuedEditAttachment: (attachmentId: string) => void;
  readonly environmentId: EnvironmentId;
  readonly projectWorkspaceRoot: string | null;
  readonly threadCwd: string | null;
  readonly selectedThreadQueueCount: number;
  readonly queuedMessages: ReadonlyArray<QueuedThreadMessage>;
  readonly dispatchingMessageId: MessageId | null;
  readonly serverConfig: GoatServerConfig | null;
  readonly layoutVariant?: LayoutVariant;
  readonly usesAutomaticContentInsets?: boolean;
  readonly onHeaderMaterialVisibilityChange?: (visible: boolean) => void;
  readonly onOpenConnectionEditor: () => void;
  readonly onChangeDraftMessage: (value: string) => void;
  readonly onPickDraftMedia: () => Promise<void>;
  readonly onPickDraftFiles: () => Promise<void>;
  readonly onNativePasteImages: (uris: ReadonlyArray<string>) => Promise<void>;
  readonly onNativePasteText: (paste: ComposerTextPaste) => Promise<void>;
  readonly onRemoveDraftImage: (imageId: string) => void;
  readonly onStopThread: () => void;
  /** Present while the thread's queue is held. */
  readonly onResumeQueue: (() => Promise<void>) | null;
  readonly onSendMessage: (
    followUp?: ActiveTurnComposerAction,
    beforeDispatch?: RedirectBeforeDispatch,
    onWillEnqueue?: () => void,
  ) => Promise<MessageId | null>;
  readonly onReconnectEnvironment: () => void;
  readonly canSwitchThreadProvider: boolean;
  readonly onUpdateThreadModelSelection: (modelSelection: ModelSelection) => void;
  readonly onUpdateThreadRuntimeMode: (runtimeMode: RuntimeMode) => void;
  readonly onUpdateThreadInteractionMode?: (interactionMode: ProviderInteractionMode) => void;
  readonly onRespondToApproval: ApprovalResponder;
  readonly onSelectUserInputOption: (
    requestId: RuntimeRequestId,
    question: ThreadUserInputQuestion,
    value: string,
  ) => void;
  readonly onChangeUserInputCustomAnswer: (
    requestId: RuntimeRequestId,
    questionId: string,
    customAnswer: string,
  ) => void;
  readonly onSubmitUserInput: () => Promise<unknown>;
  readonly onDismissUserInput: () => Promise<unknown>;
  readonly showContent?: boolean;
}
