import type { EnvironmentId, ThreadId } from "@goat/contracts";

type BotThread = { readonly environmentId: EnvironmentId; readonly id: ThreadId };

export const botThreadDetail = (thread: BotThread) =>
  ({
    name: "Thread",
    params: { environmentId: String(thread.environmentId), threadId: String(thread.id) },
  }) as const;

/** Opens a coding thread over the bot that started it, so Back returns to that bot: StackActions.push. */
export function openBotThreadAction(thread: BotThread) {
  const detail = botThreadDetail(thread);
  return { type: "PUSH", payload: { name: detail.name, params: detail.params } } as const;
}
