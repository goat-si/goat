import type {
  BotId,
  BotRemoteWork,
  BotThreadRow,
  ChannelListBotThreadsInput,
  ChannelListBotThreadsResult,
  ChannelTaskId,
  ExecutionEnvironmentCapabilities,
} from "@goat/contracts";

import { botThreadKey } from "./taskVisibility.ts";

/**
 * The input for one page of a bot's task history, or null when the server cannot walk it.
 * Only servers with `goatBotTaskThreadsPaged` get the key; older ones would drop it and answer
 * the current list.
 */
export function botThreadsHistoryInput(
  capabilities: ExecutionEnvironmentCapabilities | undefined,
  botId: BotId | null,
  cursor?: string,
): ChannelListBotThreadsInput | null {
  if (capabilities?.goatBotTaskThreadsPaged !== true) return null;
  return {
    ...(botId === null ? {} : { botId }),
    history: cursor === undefined ? {} : { cursor },
  };
}

/**
 * The current list with the history pages read after it, each row once and the current list's
 * copy first. A walk goes on while the last page has a nextCursor, even past a page with no rows,
 * and starts again from its first page whenever the current list is read again, since tasks
 * created since then sort above where it began.
 */
export function mergeBotThreadHistory(
  current: ChannelListBotThreadsResult,
  pages: ReadonlyArray<ChannelListBotThreadsResult>,
): {
  readonly rows: ReadonlyArray<BotThreadRow>;
  readonly remoteWork: ReadonlyArray<BotRemoteWork>;
  readonly mainMessageCount: number;
  /** Tasks whose launches the history lists only in part; the rest stay in Threads. */
  readonly launchesTruncated: ReadonlySet<ChannelTaskId>;
} {
  const seen = new Set<string>();
  const rows: BotThreadRow[] = [];
  for (const row of [current, ...pages].flatMap((page) => page.rows)) {
    const key = botThreadKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
  }
  const remoteIds = new Set<string>();
  const remoteWork: BotRemoteWork[] = [];
  for (const item of [current, ...pages].flatMap((page) => page.remoteWork ?? [])) {
    if (remoteIds.has(item.childWorkId)) continue;
    remoteIds.add(item.childWorkId);
    remoteWork.push(item);
  }
  // The current list carries every launch of the tasks it lists.
  const complete = new Set(
    current.rows.flatMap((row) => (row.kind === "task" ? [row.task.taskId] : [])),
  );
  return {
    rows,
    remoteWork,
    mainMessageCount: current.mainMessageCount,
    launchesTruncated: new Set(
      pages
        .flatMap((page) => page.history?.launchesTruncated ?? [])
        .filter((taskId) => !complete.has(taskId)),
    ),
  };
}
