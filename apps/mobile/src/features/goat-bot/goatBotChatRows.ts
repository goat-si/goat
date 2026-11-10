import type { GoatBotGroupPosition, GoatBotRow } from "@goat/client-runtime/goatBot";

type ContentRow = Exclude<GoatBotRow, { kind: "day" }>;
type TaskRow = Extract<GoatBotRow, { kind: "task" }>;

/**
 * The shared timeline with each row as `present` shows it, or without it when that returns null.
 * Groups keep the boundaries the full timeline drew, so a hidden row never merges its neighbours;
 * the rows left in a group get their positions again, and a day stamp that only headed hidden rows
 * goes with them.
 */
export function goatBotChatRows(
  rows: ReadonlyArray<GoatBotRow>,
  present: (row: ContentRow) => ContentRow | null,
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
    const shown = present(row);
    if (shown !== null) group.push(shown);
  }
  flush();
  return out;
}

/**
 * Finished work said as the bot's reply: its result, or that it failed. Work still running or
 * waiting leaves no row; the progress line and the question cards speak for it.
 */
export function goatBotTaskAnswer(row: TaskRow): ContentRow | null {
  const { card } = row;
  const failed = card.tone === "danger";
  if (card.tone !== "success" && !failed) return null;
  const text = card.summary ?? (failed ? `${card.statusLabel}: ${card.title}` : null);
  if (text === null) return null;
  return {
    kind: "bot",
    id: row.id,
    text,
    createdAt: card.updatedAt,
    tone: failed ? "failure" : "reply",
    proactive: false,
    replyTo: null,
    options: [],
    firstInGroup: row.firstInGroup,
    groupPosition: row.groupPosition,
  };
}
