import type { GoatBotRow } from "@goat/client-runtime/goatBot";

/** When a row last said something the person may not have read: a bot message or a kept card. */
function botSpokeAt(row: GoatBotRow): number | null {
  if (row.kind === "bot") return Date.parse(row.createdAt);
  if (row.kind === "task") return Date.parse(row.card.updatedAt);
  return null;
}

const NONE: ReadonlySet<string> = new Set();

/**
 * What the bot said after the person last read the chat and up to the newest message there was
 * when they opened it: the first such row, where the "New" divider goes, and how many there are.
 * Replies after that are read as they arrive. Rows in `kept`, marked earlier in the same visit,
 * stay marked when they change again. Null with no read position or nothing in between.
 */
export function goatBotUnreadMark(
  rows: ReadonlyArray<GoatBotRow>,
  readUpTo: string | null,
  newestAtOpen: string | null,
  kept: ReadonlySet<string> = NONE,
): {
  readonly firstId: string;
  readonly count: number;
  readonly ids: ReadonlyArray<string>;
} | null {
  if (readUpTo === null || newestAtOpen === null) return null;
  const read = Date.parse(readUpTo);
  const newest = Date.parse(newestAtOpen);
  const ids: string[] = [];
  for (const row of rows) {
    if (!kept.has(row.id)) {
      const spoke = botSpokeAt(row);
      if (spoke === null || !(spoke > read) || spoke > newest) continue;
    }
    ids.push(row.id);
  }
  const firstId = ids[0];
  return firstId === undefined ? null : { firstId, count: ids.length, ids };
}
