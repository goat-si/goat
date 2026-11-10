import type { GoatBotRow } from "@goat/client-runtime/goatBot";

/** When a row last said something the person may not have read: a bot message or a kept card. */
function botSpokeAt(row: GoatBotRow): number | null {
  if (row.kind === "bot") return Date.parse(row.createdAt);
  if (row.kind === "task") return Date.parse(row.card.updatedAt);
  return null;
}

/**
 * What the bot said after the person last read the chat and up to the newest message there was
 * when they opened it: the first such row, where the "New" divider goes, and how many there are.
 * Replies after that are read as they arrive. Null with no read position or nothing in between.
 */
export function goatBotUnreadMark(
  rows: ReadonlyArray<GoatBotRow>,
  readUpTo: string | null,
  newestAtOpen: string | null,
): { readonly firstId: string; readonly count: number } | null {
  if (readUpTo === null || newestAtOpen === null) return null;
  const read = Date.parse(readUpTo);
  const newest = Date.parse(newestAtOpen);
  let firstId: string | null = null;
  let count = 0;
  for (const row of rows) {
    const spoke = botSpokeAt(row);
    if (spoke === null || !(spoke > read) || spoke > newest) continue;
    firstId ??= row.id;
    count += 1;
  }
  return firstId === null ? null : { firstId, count };
}
