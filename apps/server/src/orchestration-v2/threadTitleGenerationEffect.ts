import { isSideChatThread } from "@goat/contracts";
import type { CommandId, MessageId, OrchestrationV2AppThread, ThreadId } from "@goat/contracts";

import type { PendingOrchestrationEffectV2 } from "./EffectOutbox.ts";

export function pendingThreadTitleGenerationEffect(
  commandId: CommandId,
  threadId: ThreadId,
  kind:
    | { readonly type: "initial"; readonly messageId: MessageId }
    | { readonly type: "regenerate" },
): PendingOrchestrationEffectV2 {
  return {
    id: `effect:${commandId}:thread-title.generate`,
    commandId,
    threadId,
    request: { type: "thread-title.generate", kind },
  };
}

export const placeholderThreadTitle = (parentTitle: string, index: number): string =>
  `${parentTitle} thread ${index + 1}`;

export function hasTitleSetBeforeFirstMessage(thread: OrchestrationV2AppThread, titleSeed: string) {
  const title = thread.title.trim();
  return (
    thread.forkedFrom === null &&
    !isSideChatThread(thread) &&
    title.length > 0 &&
    title !== "New thread" &&
    !/ thread \d+$/u.test(title) &&
    title !== titleSeed.trim()
  );
}
