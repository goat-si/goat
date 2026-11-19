import type * as EffectAcpSchema from "effect-acp/compat";

/** Stop reasons where the agent ended without finishing. ACP asks clients to show refusals. */
export function acpUnfinishedStopMessage(
  stopReason: EffectAcpSchema.StopReason | null | undefined,
): string | undefined {
  switch (stopReason) {
    case "refusal":
      return "The agent refused this request. The agent's next turn won't include this message or its reply.";
    case "max_tokens":
      return "The agent stopped because its reply reached the output token limit.";
    case "max_turn_requests":
      return "The agent stopped because it reached its request limit for this turn.";
    default:
      return undefined;
  }
}
