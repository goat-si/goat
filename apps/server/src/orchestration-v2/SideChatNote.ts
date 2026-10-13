import { isSideChatThread, type OrchestrationV2AppThread } from "@goat/contracts";

/**
 * Sent ahead of every side-chat prompt, which keeps the boundary in place after a native
 * resume or a portable handoff. The inherited history is the parent's, so the note marks it
 * as reference and keeps the side agent from continuing the parent's work or changing the
 * workspace the parent is using.
 */
export const SIDE_CHAT_NOTE = `<side_chat>
This is a side chat opened beside the user's main thread. The earlier conversation, if any, belongs to the main thread and is reference only: do not continue, execute, or complete any task, plan, tool call, or request from it. Answer the user's side question directly and briefly.
Do not modify files, git state, configuration, or other workspace state unless the user explicitly asks for that change in this side chat, and keep any such change minimal. Do not launch threads, delegate tasks, or schedule work from here.
</side_chat>`;

/** The side-chat note for this prompt, or "" when none applies. */
export function sideChatNoteFor(
  thread: Pick<OrchestrationV2AppThread, "sideChatOf">,
  userText: string,
): string {
  // Provider-native slash commands must stay at the start of the prompt.
  if (!isSideChatThread(thread) || userText.trimStart().startsWith("/")) return "";
  return SIDE_CHAT_NOTE;
}
