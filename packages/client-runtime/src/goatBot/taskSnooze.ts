import type { BotThreadRow, ChannelListBotThreadsResult } from "@goat/contracts";

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
export type BotSnoozeFoldPages = {
  readonly scope: string;
  readonly rows: SnoozedTasks;
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
  readonly first: Pick<ChannelListBotThreadsResult, "snoozed" | "snoozedNextCursor"> | null;
  readonly pages: BotSnoozeFoldPages | undefined;
  readonly setPages: (
    update: (prior: BotSnoozeFoldPages | undefined) => BotSnoozeFoldPages | undefined,
  ) => void;
  readonly read: ((cursor: string) => Promise<ChannelListBotThreadsResult | undefined>) | null;
}) {
  const { scope, first, setPages, read } = input;
  const pages = input.pages?.scope === scope ? input.pages : undefined;
  const cursor = pages === undefined ? first?.snoozedNextCursor : pages.nextCursor;
  const initial = first?.snoozed ?? [];
  const rows = pages === undefined ? initial : [...initial, ...pages.rows];
  async function loadMore() {
    if (cursor === undefined || read === null || pages?.loading) return;
    const pending = {
      scope,
      rows: pages?.rows ?? [],
      nextCursor: cursor,
      loading: true,
      failed: false,
    };
    setPages(() => pending);
    const result = await read(cursor).catch(() => undefined);
    setPages((prior) => {
      if (prior !== pending) return prior;
      if (result === undefined) return { ...pending, loading: false, failed: true };
      const seen = new Set(rows.map((row) => row.task.taskId));
      return {
        scope,
        rows: [
          ...pending.rows,
          ...(result.snoozed ?? []).filter((row) => !seen.has(row.task.taskId)),
        ],
        nextCursor: result.snoozedNextCursor,
        loading: false,
        failed: false,
      };
    });
  }
  return {
    rows,
    continuation:
      cursor === undefined || read === null
        ? undefined
        : { loading: pages?.loading ?? false, failed: pages?.failed ?? false, loadMore },
  };
}
