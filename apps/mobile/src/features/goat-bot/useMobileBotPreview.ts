import { scopeThreadRef } from "@goat/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@goat/contracts";
import {
  buildGoatBotTimeline,
  goatBotConversationPreview,
  goatBotItemReaders,
} from "@goat/client-runtime/goatBot";
import { useThreadShell } from "../../state/entities";
import { useThreadVisibleTurnItems } from "../../state/use-thread-detail";

/** A bot conversation's newest message and whether it is unread; null reads nothing. */
export function useMobileBotPreview(
  botRef: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId } | null,
) {
  const ref = botRef ? scopeThreadRef(botRef.environmentId, botRef.threadId) : null;
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
  return goatBotConversationPreview({ rows, lastVisitedAt: shell?.lastVisitedAt, active: false });
}
