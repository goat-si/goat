import type { OrchestrationV2ConversationMessage } from "@goat/contracts";
import type { manualContinuationDelivery } from "@goat/shared/orchestrationV2ManualContinuation";

export function message(
  message: OrchestrationV2ConversationMessage,
  brief: string | undefined,
  delivery: ReturnType<typeof manualContinuationDelivery> | undefined,
  nativeResume: boolean,
) {
  if (brief !== undefined) return { ...message, text: brief };
  return delivery?.type === "native" && !nativeResume && message.text.trim() === ""
    ? { ...message, text: "Continue where you left off." }
    : message;
}
