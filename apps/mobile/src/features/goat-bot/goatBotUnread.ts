import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import type { GoatBotAwayInterval } from "./useGoatBotVisitSnapshot";

/** When a row last said something the person may not have read: a bot message or a kept card. */
function botSpokeAt(row: GoatBotRow): number | null {
  if (row.kind === "bot") return Date.parse(row.createdAt);
  if (row.kind === "task") return Date.parse(row.card.updatedAt);
  return null;
}

const NONE: ReadonlySet<string> = new Set();
const NO_AWAY: ReadonlyArray<GoatBotAwayInterval> = [];

/**
 * What the bot said after the person last read the chat and up to the newest message there was
 * when they opened it, and what came in each moment they were away: the first such row, where the
 * "New" divider goes, and how many there are. Other replies are read as they arrive. Rows in
 * `kept`, marked earlier in the same visit, stay marked when they change again.
 */
export function goatBotUnreadMark(
  rows: ReadonlyArray<GoatBotRow>,
  readUpTo: string | null,
  newestAtOpen: string | null,
  kept: ReadonlySet<string> = NONE,
  away: ReadonlyArray<GoatBotAwayInterval> = NO_AWAY,
): {
  readonly firstId: string;
  readonly count: number;
  readonly ids: ReadonlyArray<string>;
} | null {
  const intervals = [
    ...(readUpTo === null || newestAtOpen === null
      ? []
      : [{ after: Date.parse(readUpTo), upTo: Date.parse(newestAtOpen) }]),
    ...away.flatMap((interval) =>
      interval.upTo === null
        ? []
        : [
            {
              after: interval.after === null ? -Infinity : Date.parse(interval.after),
              upTo: Date.parse(interval.upTo),
            },
          ],
    ),
  ];
  const ids: string[] = [];
  for (const row of rows) {
    if (!kept.has(row.id)) {
      const spoke = botSpokeAt(row);
      if (spoke === null || !intervals.some((span) => spoke > span.after && spoke <= span.upTo))
        continue;
    }
    ids.push(row.id);
  }
  const firstId = ids[0];
  return firstId === undefined ? null : { firstId, count: ids.length, ids };
}
