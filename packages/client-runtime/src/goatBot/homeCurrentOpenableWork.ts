import type {
  BotId,
  ChannelListBotThreadsResult,
  ChannelTaskId,
  EnvironmentId,
  ThreadId,
} from "@goat/contracts";
import { botHomeWork, type BotHomeWork } from "./botWork.ts";
import { resolveRemoteBotWork } from "./remoteWork.ts";

export type HomeCurrentOpenableLink = {
  readonly taskId: ChannelTaskId;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly kind: "worker" | "coding" | "remote";
  readonly launchedFrom?: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };
  readonly remoteChildWorkId?: string;
};
export type HomeCurrentOpenableWork = {
  readonly eligible: boolean;
  readonly list: "ready" | "pending" | "failed";
  readonly work: BotHomeWork;
  readonly links: ReadonlyArray<HomeCurrentOpenableLink>;
};

/**
 * Whether an environment's Home links govern its thread lists and sidebar: only once its roster
 * is known and every bot on it is eligible, so a member still loading never loses its rows.
 */
export const homeWorkGoverns = (work: {
  readonly rosterKnown: boolean;
  readonly byBot: ReadonlyArray<{ readonly eligible: boolean }>;
}) => work.rosterKnown && work.byBot.length > 0 && work.byBot.every((bot) => bot.eligible);

export function selectHomeCurrentOpenableWork(input: {
  readonly sourceEnvironmentId: EnvironmentId;
  readonly botId: BotId;
  readonly eligible: boolean;
  readonly list: "ready" | "pending" | "failed";
  readonly current: ChannelListBotThreadsResult | null;
  readonly isOpenable: (id: EnvironmentId) => boolean;
}): HomeCurrentOpenableWork {
  const { eligible, list, current, sourceEnvironmentId, isOpenable } = input;
  if (!eligible || list !== "ready" || current === null)
    return { eligible, list, work: { running: [], waiting: [], finished: [] }, links: [] };
  const work = botHomeWork(current.rows, [], sourceEnvironmentId, current.remoteWork ?? []);
  const tasks = [...work.running, ...work.waiting, ...work.finished];
  const links: HomeCurrentOpenableLink[] = [];
  for (const task of tasks) {
    const taskId = task.row.task.taskId;
    for (const thread of task.threads) {
      const worker = task.row.worker;
      const kind =
        worker?.environmentId === thread.environmentId && worker.threadId === thread.threadId
          ? "worker"
          : "coding";
      if (isOpenable(thread.environmentId)) links.push({ taskId, ...thread, kind });
    }
    for (const item of task.remote) {
      const target = resolveRemoteBotWork(item, isOpenable);
      if (target.kind === "open")
        links.push({
          taskId,
          ...target.ref,
          kind: "remote",
          remoteChildWorkId: item.childWorkId,
          launchedFrom: { environmentId: sourceEnvironmentId, threadId: item.callerThreadId },
        });
    }
  }
  return { eligible, list, work, links };
}
