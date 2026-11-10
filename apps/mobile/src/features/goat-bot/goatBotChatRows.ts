import type { GoatBotGroupPosition, GoatBotRow } from "@goat/client-runtime/goatBot";

type ContentRow = Exclude<GoatBotRow, { kind: "day" }>;

/**
 * The shared timeline without the rows `hide` drops. Groups keep the boundaries the full timeline
 * drew, so a hidden row never merges its neighbours; the rows left in a group get their positions
 * again, and a day stamp that only headed hidden rows goes with them.
 */
export function goatBotChatRows(
  rows: ReadonlyArray<GoatBotRow>,
  hide: (row: ContentRow) => boolean,
): GoatBotRow[] {
  const out: GoatBotRow[] = [];
  let pendingDay: GoatBotRow | null = null;
  let group: ContentRow[] = [];
  const flush = () => {
    group.forEach((row, index) => {
      const first = index === 0;
      const last = index === group.length - 1;
      const groupPosition: GoatBotGroupPosition = first
        ? last
          ? "single"
          : "first"
        : last
          ? "last"
          : "middle";
      if (pendingDay !== null) {
        out.push(pendingDay);
        pendingDay = null;
      }
      out.push({ ...row, firstInGroup: first, groupPosition });
    });
    group = [];
  };
  for (const row of rows) {
    if (row.kind === "day") {
      flush();
      pendingDay = row;
      continue;
    }
    if (row.firstInGroup) flush();
    if (!hide(row)) group.push(row);
  }
  flush();
  return out;
}
