import type {
  ChatAttachment,
  MessageId,
  RunId,
  ThreadId,
  UploadChatAttachment,
} from "@goat/contracts";

import type { CommandMetadata, ThreadCommandInput } from "./commands.ts";

export interface ForkThreadFromRunInput extends CommandMetadata {
  readonly sourceThreadId: ThreadId;
  readonly targetThreadId: ThreadId;
  readonly runId: RunId;
  readonly title?: string;
}

/** Forks the source's latest settled run into a hidden side chat. */
export interface ForkThreadAsSideChatInput extends CommandMetadata {
  readonly sourceThreadId: ThreadId;
  readonly targetThreadId: ThreadId;
  readonly title: string;
}

export interface MergeThreadBackInput extends CommandMetadata {
  readonly sourceThreadId: ThreadId;
  readonly targetThreadId: ThreadId;
  readonly runId: RunId;
}

export interface ResumeThreadQueueInput extends ThreadCommandInput {
  readonly runId?: RunId;
}

export interface ReorderQueuedRunInput extends ThreadCommandInput {
  readonly runId: RunId;
  readonly beforeRunId: RunId | null;
}

export interface PromoteQueuedRunInput extends ThreadCommandInput {
  readonly queuedRunId: RunId;
  readonly targetRunId: RunId;
}

export interface CancelQueuedRunInput extends ThreadCommandInput {
  readonly runId: RunId;
}

export interface RetryWorkspacePreparationInput extends ThreadCommandInput {
  readonly runId: RunId;
}

export interface EditQueuedRunInput extends ThreadCommandInput {
  readonly runId: RunId;
  readonly text: string;
  /**
   * Full replacement attachment list for the queued message. Omitted =
   * text-only edit that leaves attachments untouched.
   */
  readonly edit?: {
    readonly messageId: MessageId;
    readonly attachments: ReadonlyArray<ChatAttachment | UploadChatAttachment>;
    readonly context?: import("@goat/contracts").OrchestrationMessageContext;
  };
}
