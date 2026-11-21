import {
  CommandId,
  ThreadId,
  type ChatAttachment,
  type MessageId,
  type ModelSelection,
  type OrchestrationV2Actor,
  type OrchestrationV2CreationSource,
  type OrchestrationV2ProviderThreadNativeMetadata,
  type OrchestrationV2CloudTask,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadLauncher,
  type ProviderDriverKind,
  type ProviderInteractionMode,
  type ProjectId,
  type RunId,
  type RuntimeMode,
  type ScheduledTaskId,
} from "@goat/contracts";
import type { LaunchConfirm } from "./goat/LaunchConfirm.ts";

export type ThreadLaunchWorkspaceStrategy =
  | { readonly type: "root"; readonly branch?: string | undefined }
  | {
      readonly type: "existing_worktree";
      readonly worktreePath: string;
      readonly branch?: string | undefined;
    }
  | {
      readonly type: "worktree";
      readonly baseRef: string;
      readonly branch?: string | undefined;
      readonly startFromOrigin?: boolean | undefined;
    };

export interface ThreadLaunchInitialMessage {
  readonly ingress?: "person" | undefined;
  readonly messageId?: MessageId;
  readonly scheduledTaskId?: ScheduledTaskId;
  readonly memoryGrantCeiling?: import("@goat/contracts").MemoryTaskGrantCeiling;
  readonly senderThreadId?: ThreadId;
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly context?: import("@goat/contracts").OrchestrationMessageContext | undefined;
}

export interface ThreadLaunchInput {
  readonly commandId: CommandId;
  readonly threadId?: ThreadId;
  readonly reuseExistingThread?: boolean;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly generateTitle?: boolean;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly workspaceStrategy: ThreadLaunchWorkspaceStrategy;
  readonly initialMessage?: ThreadLaunchInitialMessage;
  readonly importedNativeThread?: {
    readonly ref: {
      readonly driver: ProviderDriverKind;
      readonly nativeId: string;
      readonly strength: "strong";
    };
    readonly metadata?: OrchestrationV2ProviderThreadNativeMetadata;
    readonly cloudTask?: OrchestrationV2CloudTask;
  };
  readonly createdBy: OrchestrationV2Actor;
  readonly creationSource: OrchestrationV2CreationSource;
  /**
   * Set when a person launches from a web, desktop, or mobile client. A missing
   * project folder then shows as a failed thread they can fix there. Every
   * other launch, including a scheduled task first created in a client, is
   * refused before a thread exists.
   */
  readonly fromClient?: boolean;
  /** The agent thread that asked for this launch; descriptive only. */
  readonly launchedBy?: OrchestrationV2ThreadLauncher | undefined;
  /** Who started a registered cloud run outside GOAT; descriptive only. */
  readonly externalLauncher?: string | undefined;
  /** Server-set: see LaunchConfirm. */
  readonly confirm?: LaunchConfirm;
}

export type PreparationInput = Pick<
  ThreadLaunchInput,
  "commandId" | "projectId" | "workspaceStrategy" | "initialMessage" | "modelSelection"
> & {
  readonly basePin?: import("@goat/contracts").WorktreePreparationBasePin;
  readonly reusedWorktree?: { readonly baseRef: string };
};

export interface ThreadLaunchPreparationInput {
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly runId: RunId;
}

export interface ThreadLaunchResult {
  readonly threadId: ThreadId;
  readonly projection: OrchestrationV2ThreadProjection;
  /** The launch's last write (the initial message, else the thread claim) was accepted before this call. */
  readonly resumed: boolean;
  readonly sequence?: number;
}
