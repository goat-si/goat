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
 * The current list with the history pages read after it, each row once, the current copy first.
 * A walk goes on while nextCursor comes back, even past an empty page, and restarts whenever the
 * current list is reread. An answer without the history marker came from a server that does not
 * walk history, so the merge reports that instead of a finished walk.
 */
export function mergeBotThreadHistory(
  current: ChannelListBotThreadsResult,
  pages: ReadonlyArray<ChannelListBotThreadsResult>,
): BotThreadHistoryMerge {
  if (pages.some((page) => page.history === undefined)) return { supported: false };
  const nextCursor = pages.at(-1)?.history?.nextCursor;
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
  return {
    supported: true,
    rows,
    remoteWork,
    mainMessageCount: current.mainMessageCount,
    // Kept even for a task the current list has: it leaves out released remote launches, and
    // launches can bind between the two reads, so its copy does not prove the set complete.
    launchesTruncated: new Set(pages.flatMap((page) => page.history?.launchesTruncated ?? [])),
    endedEarly: pages.some((page) => page.history?.endedEarly === true),
    partial: pages.some((page) => page.history?.partial === true),
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

export type BotThreadHistoryMerge =
  /** A page lacked the history marker: the server answered its current list instead. */
  | { readonly supported: false }
  | {
      readonly supported: true;
      readonly rows: ReadonlyArray<BotThreadRow>;
      readonly remoteWork: ReadonlyArray<BotRemoteWork>;
      /** The current list's; history pages do not count the bot's main messages. */
      readonly mainMessageCount: number;
      /** Tasks whose launches the history lists only in part; the rest stay in Threads. */
      readonly launchesTruncated: ReadonlySet<ChannelTaskId>;
      /** The walk stopped at a task the server could not name in a cursor. */
      readonly endedEarly: boolean;
      /** A page left out stored records it could not read, so the walk is not complete. */
      readonly partial: boolean;
      /** The last page's cursor; the walk is finished only when it is absent. */
      readonly nextCursor?: string;
    };
/** Requests one "Show more" may make; the person presses again to read further. */
export const BOT_THREAD_HISTORY_REQUESTS_PER_PRESS = 4;

/** One history answer with the cursor that asked for it, so it can be asked again. */
export interface BotThreadHistoryPage {
  readonly cursor: string | undefined;
  readonly result: ChannelListBotThreadsResult;
}

/**
 * Reads history pages from `from` until `wanted` rows not already listed came back, the walk
 * ends (no nextCursor), or this press used its requests. A short or empty page with a cursor is
 * not the end. An answer without the history marker stops the walk as unsupported.
 */
export async function readBotThreadHistory(input: {
  readonly read: (cursor: string | undefined) => Promise<ChannelListBotThreadsResult>;
  readonly from: string | undefined;
  readonly listed: ReadonlySet<string>;
  readonly wanted: number;
  readonly maxRequests?: number;
}): Promise<{ readonly pages: ReadonlyArray<BotThreadHistoryPage>; readonly supported: boolean }> {
  const pages: BotThreadHistoryPage[] = [];
  const seen = new Set(input.listed);
  let found = 0;
  let cursor = input.from;
  for (let request = 0; request < (input.maxRequests ?? BOT_THREAD_HISTORY_REQUESTS_PER_PRESS);) {
    request += 1;
    const result = await input.read(cursor);
    if (result.history === undefined) return { pages, supported: false };
    pages.push({ cursor, result });
    for (const row of result.rows) {
      const key = botThreadKey(row);
      if (row.kind === "task" && !seen.has(key)) found += 1;
      seen.add(key);
    }
    const next = result.history.nextCursor;
    if (next === undefined || next === cursor || found >= input.wanted) break;
    cursor = next;
  }
  return { pages, supported: true };
}
