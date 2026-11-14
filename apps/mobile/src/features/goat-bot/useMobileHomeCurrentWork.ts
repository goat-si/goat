import { useAtomValue } from "@effect/atom-react";
import type { HomeCurrentOpenableLink } from "@goat/client-runtime/goatBot";
import type { BotId, ChannelTaskId, EnvironmentId } from "@goat/contracts";
import { Atom } from "effect/reactivity";

import { channelEnvironment } from "../../state/channels";

const NONE = Atom.make(null).pipe(Atom.withLabel("mobile-goat-bot-home-current:none"));

/**
 * The bot's current work as Home's shared value sees it, the value that also decides which of
 * its threads Threads leaves out. Its links are known only once an eligible bot's list read has
 * answered; an ineligible bot reads no list through it.
 */
export function useMobileHomeCurrentWork(environmentId: EnvironmentId | null, botId: BotId) {
  const value = useAtomValue(
    environmentId === null
      ? NONE
      : channelEnvironment.homeCurrentOpenableWorkAtom([environmentId, botId]),
  );
  const eligible = value?.eligible === true;
  if (value === null || !eligible || value.list !== "ready")
    return { eligible, linksFor: (_taskId: ChannelTaskId) => null };
  const byTask = new Map<ChannelTaskId, HomeCurrentOpenableLink[]>();
  for (const task of [...value.work.running, ...value.work.waiting, ...value.work.finished])
    byTask.set(task.row.task.taskId, []);
  for (const link of value.links) byTask.get(link.taskId)?.push(link);
  return {
    eligible,
    /** The links for a task the current list holds; null for any other task. */
    linksFor: (taskId: ChannelTaskId): ReadonlyArray<HomeCurrentOpenableLink> | null =>
      byTask.get(taskId) ?? null,
  };
}
