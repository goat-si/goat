import type { BotThreadRow, ChannelListBotThreadsResult } from "@goat/contracts";
import { BOT_WORK_HISTORY_LIMIT } from "./botWorkHistory.ts";

export const BOT_TASK_SNOOZE_CHOICES = [
  { id: "hour", label: "1 hour" },
  { id: "tomorrow", label: "Tomorrow" },
  { id: "week", label: "Next week" },
] as const;

export function botTaskSnoozeInput(choice: string) {
  const preset = BOT_TASK_SNOOZE_CHOICES.find(({ id }) => id === choice)?.id;
  if (preset === undefined) return undefined;
  return preset === "hour"
    ? { preset }
    : { preset, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
}

export function withoutSnoozedBotTasks(
  rows: ReadonlyArray<BotThreadRow>,
  snoozed: ReadonlyArray<Extract<BotThreadRow, { kind: "task" }>>,
) {
  const hidden = new Set(snoozed.map((row) => row.task.taskId));
  for (const row of rows)
    if (row.kind === "task" && row.view.snoozedUntil !== undefined) hidden.add(row.task.taskId);
  return rows.filter((row) => !hidden.has(row.kind === "task" ? row.task.taskId : row.taskId));
}

type SnoozedTasks = NonNullable<ChannelListBotThreadsResult["snoozed"]>;
type SnoozeRead = Pick<
  ChannelListBotThreadsResult,
  "rows" | "snoozed" | "snoozedNextCursor" | "snoozedRevision"
>;
const NO_SNOOZED_TASKS: SnoozedTasks = [];
export type BotSnoozeFoldPages = {
  readonly scope: string;
  readonly rows: SnoozedTasks;
  readonly firstCursor: string | undefined;
  readonly revision: string | undefined;
  readonly nextCursor: string | undefined;
  readonly loading: boolean;
  readonly failed: boolean;
};

export type BotSnoozeFoldContinuation = {
  readonly loading: boolean;
  readonly failed: boolean;
  readonly loadMore: () => void;
};

export function botSnoozeFold(input: {
  readonly scope: string;
  readonly first: SnoozeRead;
  readonly loaded: boolean;
  readonly home: { readonly isPending: boolean; readonly refresh: () => void };
  readonly activeSnoozes?: ChannelListBotThreadsResult["activeSnoozes"];
  readonly pages: BotSnoozeFoldPages | undefined;
  readonly setPages: (
    update: (prior: BotSnoozeFoldPages | undefined) => BotSnoozeFoldPages | undefined,
  ) => void;
  readonly read: ((cursor: string) => Promise<ChannelListBotThreadsResult | undefined>) | null;
}) {
  const { scope, first, home, setPages, read } = input;
  const pages = input.pages?.scope === scope ? input.pages : undefined;
  const firstCursor = first.snoozedNextCursor;
  const revision = first.snoozedRevision;
  const continuation =
    pages?.firstCursor === firstCursor && pages?.revision === revision ? pages : undefined;
  const exhausted = input.loaded && firstCursor === undefined;
  const cursor = exhausted
    ? undefined
    : continuation === undefined
      ? firstCursor
      : continuation.nextCursor;
  const firstRows = first.snoozed ?? NO_SNOOZED_TASKS;
  const reconciled =
    pages === undefined || exhausted
      ? firstRows
      : reconcileSnoozePages(first, pages.rows, input.activeSnoozes);
  const limitReached = reconciled.length >= BOT_WORK_HISTORY_LIMIT;
  const rows = limitReached ? reconciled.slice(0, BOT_WORK_HISTORY_LIMIT) : reconciled;
  const loading = pages?.loading === true || home.isPending;
  async function loadMore() {
    if (cursor === undefined || read === null || loading || limitReached) return;
    const pending = {
      scope,
      rows,
      firstCursor,
      revision,
      nextCursor: cursor,
      loading: true,
      failed: false,
    };
    setPages(() => pending);
    const result = await read(cursor).catch(() => undefined);
    const revisionChanged =
      result !== undefined && revision !== undefined && result.snoozedRevision !== revision;
    if (revisionChanged) home.refresh();
    setPages((prior) => {
      if (prior !== pending) return prior;
      if (result === undefined) return { ...pending, loading: false, failed: true };
      if (revisionChanged) return { ...pending, loading: false };
      const merged = mergeSnoozeRows(pending.rows, result.snoozed ?? NO_SNOOZED_TASKS);
      const overflow = merged.length > BOT_WORK_HISTORY_LIMIT;
      return {
        ...pending,
        rows: overflow ? merged.slice(0, BOT_WORK_HISTORY_LIMIT) : merged,
        // Reconciliation may free space for the rest of this page.
        nextCursor: overflow ? cursor : result.snoozedNextCursor,
        loading: false,
        failed: false,
      };
    });
  }
  return {
    rows,
    limitReached,
    continuation:
      cursor === undefined || read === null || limitReached
        ? undefined
        : { loading, failed: continuation?.failed ?? false, loadMore },
  };
}

function mergeSnoozeRows(earlier: SnoozedTasks, latest: SnoozedTasks): SnoozedTasks {
  const rows = new Map(earlier.map((row) => [row.task.taskId, row]));
  for (const row of latest) rows.set(row.task.taskId, row);
  return [...rows.values()];
}

function reconcileSnoozePages(
  first: SnoozeRead,
  cached: SnoozedTasks,
  active: ChannelListBotThreadsResult["activeSnoozes"],
): SnoozedTasks {
  const firstRows = first.snoozed ?? NO_SNOOZED_TASKS;
  const known = new Set(firstRows.map((row) => row.task.taskId));
  for (const row of first.rows) if (row.kind === "task") known.add(row.task.taskId);
  const untilByTask =
    active === undefined ? undefined : new Map(active.map((row) => [row.taskId, row.until]));
  return [
    ...firstRows,
    ...cached.flatMap((row) => {
      if (known.has(row.task.taskId)) return [];
      if (untilByTask === undefined) return [row];
      const until = untilByTask.get(row.task.taskId);
      return until === undefined
        ? []
        : [
            row.view.snoozedUntil === until
              ? row
              : { ...row, view: { ...row.view, snoozedUntil: until } },
          ];
    }),
  ];
}
