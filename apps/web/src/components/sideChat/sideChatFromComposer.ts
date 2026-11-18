import type { ScopedThreadRef } from "@goat/contracts";

import { useRightPanelStore } from "../../rightPanelStore";
import { sideChatCommandOverAnswer } from "../chat/composerSubmission";
import { useSideChatStore } from "./sideChatStore";

/** Opens the thread's side chat tab with `prompt` waiting to be asked there. */
export function queueSideChatQuestion(
  threadKey: string,
  threadRef: ScopedThreadRef,
  prompt: string,
): void {
  if (prompt !== "") useSideChatStore.getState().setPendingPrompt(threadKey, prompt);
  useRightPanelStore.getState().open(threadRef, "side-chat");
}

type ComposerContextLists = Readonly<
  Record<
    | "images"
    | "files"
    | "terminalContexts"
    | "previewAnnotations"
    | "reviewComments"
    | "threadContexts",
    ReadonlyArray<unknown>
  >
>;

/**
 * Starts the side chat when the open question's typed answer is `/side …`, clearing that answer
 * and leaving the question pending. Returns whether it did.
 */
export function startSideChatOverAnswer(input: {
  readonly progress: {
    readonly customAnswer: string;
    readonly activeQuestion: { readonly id: string } | null;
  };
  readonly composer: ComposerContextLists | undefined;
  readonly sideChatAvailable: boolean;
  readonly threadKey: string | null;
  readonly threadRef: ScopedThreadRef | null;
  readonly clearAnswer: (questionId: string, value: string) => void;
}): boolean {
  const questionId = input.progress.activeQuestion?.id;
  if (questionId === undefined || input.threadKey === null || input.threadRef === null) {
    return false;
  }
  const { composer } = input;
  const command = sideChatCommandOverAnswer({
    answer: input.progress.customAnswer,
    sideChatAvailable: input.sideChatAvailable,
    hasAttachmentsOrContext:
      composer !== undefined &&
      [
        composer.images,
        composer.files,
        composer.terminalContexts,
        composer.previewAnnotations,
        composer.reviewComments,
        composer.threadContexts,
      ].some((list) => list.length > 0),
  });
  if (!command) return false;
  queueSideChatQuestion(input.threadKey, input.threadRef, command.prompt);
  input.clearAnswer(questionId, "");
  return true;
}
