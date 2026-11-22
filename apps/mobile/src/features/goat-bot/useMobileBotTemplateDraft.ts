import { clearBotTemplateDraft, readBotTemplateDraft } from "@goat/client-runtime/goatBot";
import type { BotProfile } from "@goat/contracts";
import { useEffect } from "react";

export function useMobileBotTemplateDraft(
  member: BotProfile | null | undefined,
  taskId: string | null | undefined,
): () => string {
  const environmentId = member?.environmentId;
  const threadId = member?.sessionThreadId;
  // oxlint-disable-next-line goat/react-effect-budget -- Consume the one-shot draft after the bot screen commits.
  useEffect(() => {
    if (!taskId) clearBotTemplateDraft(environmentId, threadId);
  }, [taskId, environmentId, threadId]);
  return () => {
    if (taskId) return "";
    return readBotTemplateDraft(environmentId, threadId) ?? "";
  };
}
