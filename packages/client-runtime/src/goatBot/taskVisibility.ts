import {
  isChannelChildWorkActive,
  isChannelChildWorkTerminal,
  isChannelTaskTerminal,
  type BotThreadRow,
} from "@goat/contracts";

const HOUR = 60 * 60 * 1_000;
const THREE_DAYS = 72 * HOUR;

export function botThreadKey(row: BotThreadRow): string {
  return row.kind === "task"
    ? `task:${row.task.taskId}`
    : `coding:${row.environmentId}:${row.threadId}`;
}

export function selectBotChildren({
  rows,
  now,
  showMore,
  selectedKey,
}: {
  rows: ReadonlyArray<BotThreadRow>;
  now: number;
  showMore: boolean;
  selectedKey: string | null;
}): { rows: ReadonlyArray<BotThreadRow>; hasMore: boolean } {
  const always: BotThreadRow[] = [];
  const other: BotThreadRow[] = [];
  for (const row of rows) {
    const selected = botThreadKey(row) === selectedKey;
    const pinned = row.kind === "task" && row.view.pinnedAt !== null;
    const terminal =
      row.kind === "task"
        ? row.view.doneAt !== null || isChannelTaskTerminal(row.task.status)
        : isChannelChildWorkTerminal(row.state);
    const active =
      row.kind === "task"
        ? ["received", "dispatching", "running", "waiting_input"].includes(row.task.status)
        : isChannelChildWorkActive(row.state);
    const unread = row.kind === "task" && row.unread;
    if (pinned || selected || active || unread) {
      always.push(row);
      continue;
    }
    const age =
      now -
      Date.parse(
        row.kind === "task"
          ? (row.view.doneAt ?? row.task.completedAt ?? row.lastActivityAt)
          : row.lastActivityAt,
      );
    if (terminal && age >= THREE_DAYS) continue;
    if (row.kind === "task" && age >= (terminal ? 2 : 6) * HOUR && row.mainMessagesSinceQuiet >= 10)
      continue;
    other.push(row);
  }
  const newest = (a: BotThreadRow, b: BotThreadRow) =>
    b.lastActivityAt.localeCompare(a.lastActivityAt);
  always.sort(newest);
  other.sort(newest);
  return {
    rows: [...always, ...(showMore ? other : other.slice(0, 5))],
    hasMore: other.length > 5 && !showMore,
  };
}
