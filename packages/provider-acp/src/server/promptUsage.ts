import type { OrchestrationV2ProviderTurn, TurnTokenUsage } from "@goat/contracts";
import type * as EffectAcpSchema from "effect-acp/compat";

/**
 * Maps one per-turn usage sample (flavors with reportsPerTurnPromptUsage)
 * directly onto TurnTokenUsage: the response's counters already cover exactly
 * this prompt.
 */
export function acpPerTurnPromptUsage(
  usage: EffectAcpSchema.Usage | null | undefined,
  hasSubagents: boolean,
  terminalStatus: OrchestrationV2ProviderTurn["status"],
  geminiUsage = false,
): TurnTokenUsage {
  if (usage == null) {
    return { usageScope: "main_agent", usageStatus: "unavailable", hasSubagents };
  }
  const inputTokens = geminiUsage
    ? usage.inputTokens + (usage.cachedReadTokens ?? 0)
    : usage.inputTokens;
  const outputTokens = geminiUsage
    ? usage.outputTokens + (usage.thoughtTokens ?? 0)
    : usage.outputTokens;
  // TurnTokenUsage contract: input includes cache read + write and reasoning
  // is a subset of output, so clamp counters that exceed their parent and
  // drop the ones the agent left unset. Cache writes are capped at whatever
  // cache reads leave of input, so the pair cannot exceed it.
  const clampSubset = (value: number | null | undefined, parent: number) =>
    value == null ? undefined : Math.min(value, parent);
  const cachedInputTokens = clampSubset(usage.cachedReadTokens, inputTokens);
  const cacheCreationTokens = clampSubset(
    usage.cachedWriteTokens,
    inputTokens - (cachedInputTokens ?? 0),
  );
  const reasoningTokens = clampSubset(usage.thoughtTokens, outputTokens);
  return {
    usageScope: "main_agent",
    usageStatus: terminalStatus === "completed" ? "complete" : "partial",
    hasSubagents,
    inputTokens,
    outputTokens,
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(cacheCreationTokens === undefined ? {} : { cacheCreationTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  };
}
