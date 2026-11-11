import {
  isChannelChildWorkTerminal,
  isChannelTaskTerminal,
  type BotThreadRow,
} from "@goat/contracts";

const HOUR = 60 * 60 * 1_000;
const THREE_DAYS = 72 * HOUR;
const ACTIVE_TASK_STATUSES = new Set(["received", "dispatching", "running", "waiting_input"]);

export function botThreadKey(row: BotThreadRow): string {
  return row.kind === "task"
    ? `task:${row.task.taskId}`
    : `coding:${row.environmentId}:${row.threadId}`;
}

/** Pinned, running and unread rows never age out of the bot's lists. */
const isKept = (row: BotThreadRow) =>
  row.kind === "task"
    ? row.view.pinnedAt !== null || ACTIVE_TASK_STATUSES.has(row.task.status) || row.unread
    : !isChannelChildWorkTerminal(row.state);

/**
 * When the bot's lists stop showing this row as it stands, even under Show more: a task marked
 * done ages out after three days, and a quiet one sooner once the chat moved on past it.
 * Infinity while nothing ages it out.
 */
export function botRowRetiresAt(row: BotThreadRow): number {
  if (row.kind !== "task" || isKept(row)) return Infinity;
  const doneAt = row.view.doneAt;
  const quietAt = Math.max(
    Date.parse(row.task.completedAt ?? row.lastActivityAt),
    doneAt === null ? -Infinity : Date.parse(doneAt),
  );
  if (Number.isNaN(quietAt)) return Infinity;
  let at = doneAt === null ? Infinity : quietAt + THREE_DAYS;
  if (row.mainMessagesSinceQuiet >= 10) {
    const terminal = doneAt !== null || isChannelTaskTerminal(row.task.status);
    at = Math.min(at, quietAt + (terminal ? 2 : 6) * HOUR);
  }
  return at;
}

/** When the server stops listing a finished task nobody pinned: three days after it finished. */
export function botRowListedUntil(row: BotThreadRow): number {
  if (row.kind !== "task" || row.view.pinnedAt !== null) return Infinity;
  if (!isChannelTaskTerminal(row.task.status)) return Infinity;
  const at = Date.parse(row.task.completedAt ?? row.task.updatedAt) + THREE_DAYS;
  return Number.isNaN(at) ? Infinity : at;
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
    if (botThreadKey(row) === selectedKey || isKept(row)) always.push(row);
    else if (now < botRowRetiresAt(row)) other.push(row);
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
