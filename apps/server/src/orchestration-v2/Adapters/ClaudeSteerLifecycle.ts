import { claudeEchoedPromptUuids } from "./ClaudePromptFrames.ts";
import type { ActiveClaudeTurnContext } from "./ClaudeAdapterV2.ts";

export function absorbHeldResult(context: ActiveClaudeTurnContext) {
  if (context.heldResult === undefined) return;
  const assistant = context.assistant;
  if (assistant.fallbackText.length > 0) {
    assistant.earlierFallbackText = [assistant.earlierFallbackText, assistant.fallbackText]
      .filter(Boolean)
      .join("\n\n");
    assistant.fallbackText = "";
  }
  context.steeredSegmentUsage.push(context.heldResult.usage);
  context.heldResult = undefined;
}

export function dropUnreadSteer(
  context: ActiveClaudeTurnContext,
  lifecycle: { uuid: string; state: string } | null,
) {
  const dropped =
    lifecycle !== null && ["cancelled", "discarded", "refused"].includes(lifecycle.state)
      ? context.pendingSteers.get(lifecycle.uuid)
      : undefined;
  if (dropped === undefined || lifecycle === null) return undefined;
  context.pendingSteers.delete(lifecycle.uuid);
  if (
    dropped.appContextOffered !== undefined &&
    context.appContextOffered === dropped.appContextOffered
  )
    context.appContextOffered = dropped.appContextBefore;
  const refund = dropped.pdfReservation.delivered && !dropped.pdfReservation.refunded;
  if (refund) dropped.pdfReservation.refund();
  return { refund, result: context.pendingSteers.size === 0 ? context.heldResult : undefined };
}

export function holdSuccessfulResult(
  context: ActiveClaudeTurnContext,
  status: string,
  failure: unknown,
  message: import("@anthropic-ai/claude-agent-sdk").SDKResultMessage,
) {
  if (
    status !== "completed" ||
    failure !== null ||
    context.pendingSteers.size === 0 ||
    claudeEchoedPromptUuids(message).length === 0
  )
    return false;
  context.heldResult = message;
  return true;
}
