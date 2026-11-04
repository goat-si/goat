import { isChannelChildWorkTerminal, type BotThreadRow } from "@goat/contracts";

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
    const active =
      row.kind === "task"
        ? ["received", "dispatching", "running", "waiting_input"].includes(row.task.status)
        : !isChannelChildWorkTerminal(row.state);
    const unread = row.kind === "task" && row.unread;
    if (pinned || selected || active || unread) {
      always.push(row);
      continue;
    }
    if (row.kind === "task") {
      const doneAt = row.view.doneAt;
      const age = now - Date.parse(doneAt ?? row.lastActivityAt);
      if (doneAt !== null && age >= THREE_DAYS) continue;
      if (age >= (doneAt !== null ? 2 : 6) * HOUR && row.mainMessagesSinceQuiet >= 10) continue;
    }
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
