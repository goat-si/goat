import { scopeThreadRef } from "@goat/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@goat/contracts";
import {
  buildGoatBotTimeline,
  goatBotConversationPreview,
  goatBotItemReaders,
} from "@goat/client-runtime/goatBot";
import { useThreadShell } from "../../state/entities";
import { useThreadVisibleTurnItems } from "../../state/use-thread-detail";
import { useComputerReadable } from "./useKeptPerComputer";

/**
 * A bot conversation's newest message and whether it is unread; null reads nothing. A thread keeps
 * its messages after access is refused, and the saved bot still names a removed computer, so none
 * shows once this phone may no longer read that computer.
 */
export function useMobileBotPreview(
  botRef: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId } | null,
) {
  const ref = botRef ? scopeThreadRef(botRef.environmentId, botRef.threadId) : null;
  const readable = useComputerReadable(botRef?.environmentId ?? null);
  const shell = useThreadShell(ref);
  const items = useThreadVisibleTurnItems({
    environmentId: botRef?.environmentId ?? null,
    threadId: botRef?.threadId ?? null,
  });
  const rows = buildGoatBotTimeline({
    visibleTurnItems: items,
    pendingInputs: [],
    readers: goatBotItemReaders,
    // The bot's own conversation, read as its main chat.
    taskId: null,
    // As the chat reads it: an answer is what the server recorded.
    answerReferences: true,
  });
  if (!readable) return null;
  return goatBotConversationPreview({ rows, lastVisitedAt: shell?.lastVisitedAt, active: false });
}
