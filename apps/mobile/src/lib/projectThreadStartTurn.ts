import {
  CommandId,
  MessageId,
  ThreadId,
  type ChatAttachment,
  type ModelSelection,
  type OrchestrationMessageContext,
  type ProjectId,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@goat/contracts";
import { deriveThreadTitleSeed, threadTitleTextFromPrompt } from "@goat/client-runtime/operations";

import type { UploadedMobileAttachment } from "./attachmentUpload";

export interface ProjectThreadStartTurnSpec {
  readonly projectId: ProjectId;
  readonly projectCwd: string;
  readonly threadId: string;
  readonly commandId: string;
  readonly messageId: string;
  readonly createdAt: string;
  readonly text: string;
  readonly titleText?: string;
  readonly context?: OrchestrationMessageContext;
  readonly uploadedAttachments: ReadonlyArray<UploadedMobileAttachment | ChatAttachment>;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly workspaceMode: "local" | "worktree";
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly startFromOrigin: boolean;
  readonly worktreeBranchName: string;
}

export function buildProjectThreadStartTurnInput(spec: ProjectThreadStartTurnSpec) {
  const title = deriveThreadTitleSeed({
    text: spec.titleText ?? spec.text,
    attachments: spec.uploadedAttachments,
  });
  const isWorktree = spec.workspaceMode === "worktree";
  return {
    commandId: CommandId.make(spec.commandId),
    creationSource: "mobile" as const,
    threadId: ThreadId.make(spec.threadId),
    message: {
      messageId: MessageId.make(spec.messageId),
      role: "user" as const,
      text: spec.text,
      ...(spec.context ? { context: spec.context } : {}),
      attachments: spec.uploadedAttachments,
    },
    modelSelection: spec.modelSelection,
    titleSeed: title,
    runtimeMode: spec.runtimeMode,
    interactionMode: spec.interactionMode,
    bootstrap: {
      createThread: {
        projectId: spec.projectId,
        title,
        modelSelection: spec.modelSelection,
        runtimeMode: spec.runtimeMode,
        interactionMode: spec.interactionMode,
        branch: spec.branch,
        worktreePath: isWorktree ? null : spec.worktreePath,
        createdAt: spec.createdAt,
      },
      ...(isWorktree
        ? {
            prepareWorktree: {
              projectCwd: spec.projectCwd,
              baseBranch: spec.branch!,
              branch: spec.worktreeBranchName,
              ...(spec.startFromOrigin ? { startFromOrigin: true } : {}),
            },
            runSetupScript: true,
          }
        : {}),
    },
    createdAt: spec.createdAt,
  };
}

function splitsSurrogatePair(text: string, offset: number): boolean {
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

export function deriveThreadTitleFromPrompt(value: string): string {
  const title = threadTitleTextFromPrompt(value) || "New thread";
  if (title.length <= 72) return title;
  const end = splitsSurrogatePair(title, 69) ? 68 : 69;
  return `${title.slice(0, end).trimEnd()}...`;
}

/** Titles a new task the server has not created yet; one with only attachments shows their count. */
export function deriveUnsentThreadTitle(input: {
  readonly text: string;
  readonly attachments: ReadonlyArray<unknown>;
}): string {
  if (input.text.trim().length > 0 || input.attachments.length === 0) {
    return deriveThreadTitleFromPrompt(input.text);
  }
  const count = input.attachments.length;
  return count === 1 ? "1 attachment" : `${count} attachments`;
}
