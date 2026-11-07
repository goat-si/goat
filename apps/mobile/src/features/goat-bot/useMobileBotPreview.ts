import { scopeThreadRef } from "@goat/client-runtime/environment";
import {
  buildGoatBotTimeline,
  goatBotConversationPreview,
  goatBotItemReaders,
} from "@goat/client-runtime/goatBot";
import { useThreadShell } from "../../state/entities";
import { useThreadVisibleTurnItems } from "../../state/use-thread-detail";
import { useMobileGoatBotHomeMode } from "./useMobileGoatBotHomeMode";

export function useMobileBotPreview() {
  const { botRef } = useMobileGoatBotHomeMode();
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
  });
  return goatBotConversationPreview({ rows, lastVisitedAt: shell?.lastVisitedAt, active: false });
}
