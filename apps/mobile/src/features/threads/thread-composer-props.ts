import type { ActiveTurnComposerAction } from "@goat/client-runtime/state/composer-dispatch";
import type { EnvironmentThreadShell } from "@goat/client-runtime/state/shell";
import type {
  ChatAttachment,
  EnvironmentId,
  MessageId,
  ModelSelection,
  ProviderInteractionMode,
  RuntimeMode,
  ServerConfig as GoatServerConfig,
  UsageLimitsReport,
} from "@goat/contracts";
import type { ReactNode, RefObject } from "react";
import type { ComposerEditorHandle } from "../../components/ComposerEditor";
import type { RemoteClientConnectionState } from "../../lib/connection";
import type { FollowUpBehavior } from "../../lib/followUpBehavior";
import type { ComposerTextPaste } from "../../native/GoatComposerEditor.types";

export interface ThreadComposerProps {
  readonly isDraft?: boolean;
  readonly canOperateThread: boolean;
  readonly placeholder: string;
  readonly contentMaxWidth?: number;
  readonly draftControls?: ReactNode;
  readonly bottomInset?: number;
  readonly connectionState: RemoteClientConnectionState;
  readonly environmentLabel: string | null;
  readonly threadSyncPhase?: "loading" | "syncing" | null;
  readonly selectedThread: EnvironmentThreadShell;
  readonly reportedModelSelection?: ModelSelection | null;
  readonly hasCompactableConversation: boolean;
  readonly serverConfig: GoatServerConfig | null;
  readonly queueCount: number;
  readonly activeThreadBusy: boolean;
  readonly canStopThread: boolean;
  readonly environmentId: EnvironmentId;
  readonly projectCwd: string | null;
  readonly sendBlockedReason?: string | null;
  readonly interactionLocked?: boolean;
  readonly draftKey?: string;
  readonly queuedEdit?: {
    readonly existingAttachments: ReadonlyArray<ChatAttachment>;
    readonly saving: boolean;
    readonly onRemoveExistingAttachment: (attachmentId: string) => void;
  } | null;
  readonly followUpBehavior: FollowUpBehavior;
  readonly canSteerActiveTurn: boolean;
  readonly hidden: boolean;
  readonly editorRef?: RefObject<ComposerEditorHandle | null>;
  readonly onChangeDraftMessage: (value: string) => void;
  readonly onPickDraftMedia: () => Promise<void>;
  readonly onPickDraftFiles: () => Promise<void>;
  readonly onNativePasteImages: (uris: ReadonlyArray<string>) => Promise<void>;
  readonly onNativePasteText: (paste: ComposerTextPaste) => Promise<void>;
  readonly onRemoveDraftImage: (imageId: string) => void;
  readonly onStopThread: () => void;
  /** Present while the thread's queue is held. */
  readonly onResumeQueue: (() => Promise<void>) | null;
  /** `stillSendable` reports whether the draft is unchanged after any wait before sending. */
  readonly onSendMessage: (
    followUp?: ActiveTurnComposerAction,
    stillSendable?: () => boolean,
  ) => Promise<MessageId | null>;
  readonly onShowUsageLimits: (report: UsageLimitsReport | null) => void;
  readonly canSwitchProvider: boolean;
  readonly onUpdateModelSelection: (modelSelection: ModelSelection) => void;
  readonly onUpdateRuntimeMode: (runtimeMode: RuntimeMode) => void;
  readonly onUpdateInteractionMode?: (interactionMode: ProviderInteractionMode) => void;
  readonly onEditorFocusChange?: (focused: boolean) => void;
}
