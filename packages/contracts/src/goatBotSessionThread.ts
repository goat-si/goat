/** GOAT Bot's per-conversation session threads. The server mints these ids; clients keep them out of thread lists. */
export const GOAT_BOT_SESSION_THREAD_PREFIX = "goat-bot-session:";

export const isGoatBotSessionThreadId = (threadId: string): boolean =>
  threadId.startsWith(GOAT_BOT_SESSION_THREAD_PREFIX);
