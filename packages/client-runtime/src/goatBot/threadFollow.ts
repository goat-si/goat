import {
  ChannelGatewayError,
  isGoatBotSessionThreadId,
  type ScopedThreadRef,
} from "@goat/contracts";
import type { AtomRegistry } from "effect/reactivity";
import type { createChannelEnvironmentAtoms } from "../state/channels.ts";
import * as Schema from "effect/Schema";
import { runAtomCommand, squashAtomCommandFailure } from "../state/runtime.ts";

const isGatewayError = Schema.is(ChannelGatewayError);

type Commands = ReturnType<typeof createChannelEnvironmentAtoms>;

export function threadFollowSupported(thread: ScopedThreadRef, capability: boolean | undefined) {
  return capability === true && !isGoatBotSessionThreadId(thread.threadId);
}

export async function chooseThreadFollow(
  registry: AtomRegistry.AtomRegistry,
  commands: Commands,
  thread: ScopedThreadRef,
  action: "follow" | "stop",
  pick: (
    title: string,
    options: ReadonlyArray<{ id: string; label: string }>,
  ) => Promise<string | null>,
  notice: (message: string) => void,
  signal?: AbortSignal,
) {
  const { environmentId } = thread;
  const command = action === "follow" ? commands.followThread : commands.stopFollowingThread;
  if (!registry.get(command.permissionAtom(environmentId))) return;
  const roster = await runAtomCommand(registry, commands.readBotRoster, {
    environmentId,
    input: {},
  });
  if (signal?.aborted) return;
  if (roster._tag !== "Success") return notice("Could not load bots.");
  const bots = roster.value.bots.filter(
    (bot) => !bot.hidden && bot.sessionThreadId !== thread.threadId,
  );
  if (bots.length === 0) return notice("No bots are available on this computer.");
  const choice = await pick(
    "Choose a bot",
    bots.map((bot) => ({ id: bot.botId, label: bot.name })),
  );
  const bot = bots.find(({ botId }) => botId === choice);
  if (!bot || signal?.aborted) return;
  const target = { ...thread, botId: bot.botId };
  if (action === "stop") {
    const follows = await runAtomCommand(registry, commands.listFollowedThreads, {
      environmentId,
      input: { botId: bot.botId },
    });
    if (signal?.aborted) return;
    if (follows._tag !== "Success") return notice("Could not check this bot’s followed threads.");
    if (
      !follows.value.followedThreads.some(
        (row) => row.threadId === thread.threadId && row.environmentId === environmentId,
      )
    ) {
      return notice(`${bot.name} is not following this thread.`);
    }
    const result = await runAtomCommand(registry, commands.stopFollowingThread, {
      environmentId,
      input: target,
    });
    if (result._tag !== "Success") notice("Could not stop following this thread.");
    return;
  }
  const work = await runAtomCommand(registry, commands.listBotThreadsPage, {
    environmentId,
    input: bot.role === "main" ? {} : { botId: bot.botId },
  });
  if (signal?.aborted) return;
  if (work._tag !== "Success") return notice("Could not load this bot’s tasks.");
  const tasks = work.value.rows.flatMap((row) => (row.kind === "task" ? [row.task] : []));
  if (tasks.length === 0)
    return notice(`${bot.name} has no visible tasks. Ask it to start a task first.`);
  const taskChoice = await pick(
    "Choose a bot task",
    tasks.map((task) => ({ id: task.taskId, label: task.title })),
  );
  const task = tasks.find(({ taskId }) => taskId === taskChoice);
  if (!task || signal?.aborted) return;
  const result = await runAtomCommand(registry, commands.followThread, {
    environmentId,
    input: { ...target, taskId: task.taskId },
  });
  if (result._tag === "Failure") {
    const error = squashAtomCommandFailure(result);
    notice(
      isGatewayError(error) && error.reason === "cross_environment_follow"
        ? error.message
        : "Could not follow this thread.",
    );
  }
}
