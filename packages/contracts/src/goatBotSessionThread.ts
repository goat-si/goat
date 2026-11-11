/** GOAT Bot's per-conversation session threads. The server mints these ids; clients keep them out of thread lists. */
export const GOAT_BOT_SESSION_THREAD_PREFIX = "goat-bot-session:";

export const isGoatBotSessionThreadId = (threadId: string): boolean =>
  threadId.startsWith(GOAT_BOT_SESSION_THREAD_PREFIX);

/**
 * Threads that are a GOAT Bot conversation: its session threads, the main bot's thread and each
 * member bot's. The bot list always opens them, so thread lists leave them out by id.
 */
export const isGoatBotConversationThreadId = (threadId: string): boolean =>
  isGoatBotSessionThreadId(threadId) ||
  threadId.startsWith("channel-bot:") ||
  threadId.startsWith("channel-member-bot:");
