import { goatBotItemReaders, type GoatBotRow } from "@goat/client-runtime/goatBot";
import type { OrchestrationV2ProjectedTurnItem } from "@goat/contracts";

/**
 * The chat row of a routine run's reply: the first shown bot row whose item answered the run's
 * input. Rows don't carry the input they answer; their items do.
 */
export function goatBotRunReplyRow(
  items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
  rows: ReadonlyArray<GoatBotRow>,
  inputId: string,
): string | null {
  const shown = new Set(rows.flatMap((row) => (row.kind === "bot" ? [row.id] : [])));
  for (const { item } of items) {
    if (item.type !== "assistant_message" || !shown.has(item.id)) continue;
    if (goatBotItemReaders.message(item)?.replyToKey === inputId) return item.id;
  }
  return null;
}

/** Scrolls a chat row to the middle of the conversation; null when it isn't there. */
export function centerGoatBotRow(root: ParentNode | null, rowId: string): HTMLElement | null {
  const element = Array.from(root?.querySelectorAll<HTMLElement>("[data-bot-row]") ?? []).find(
    (node) => node.dataset.botRow === rowId,
  );
  if (element === undefined) return null;
  element.scrollIntoView({ block: "center" });
  return element;
}

export function focusGoatBotRow(root: ParentNode | null, rowId: string) {
  centerGoatBotRow(root, rowId)?.focus({ preventScroll: true });
}
