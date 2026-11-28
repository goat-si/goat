import { splitsSurrogatePair } from "@goat/shared/assistantCitations";

const limit = 64 * 1024;
export const loggedWebhookPrompt = (prompt: string) =>
  prompt.slice(0, splitsSurrogatePair(prompt, limit) ? limit - 1 : limit);
