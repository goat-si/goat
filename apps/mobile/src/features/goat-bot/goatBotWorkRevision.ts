import type { OrchestrationV2ProjectedTurnItem } from "@goat/contracts";

/**
 * What the bot's work list depends on in its conversation: every task chip revision, bot-turn chips
 * included, and every channel message once it is complete. A streaming answer's growing text
 * changes nothing, so the list is not refetched for each streamed chunk.
 */
export function goatBotWorkRevision(
  visibleTurnItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
): string {
  const parts: string[] = [];
  for (const { sourceItemId, item } of visibleTurnItems) {
    if (item.type === "notification") {
      if (item.ledgerTask !== undefined)
        parts.push(`${item.ledgerTask.taskId}:${item.ledgerTask.taskVersion}`);
    } else if (item.type === "user_message") {
      if (item.channel !== undefined) parts.push(sourceItemId);
    } else if (item.type === "assistant_message") {
      if (item.channel !== undefined && item.streaming !== true) parts.push(sourceItemId);
    }
  }
  return parts.join("|");
}
