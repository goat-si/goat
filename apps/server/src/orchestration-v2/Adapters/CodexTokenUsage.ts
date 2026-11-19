import type * as CodexSchema from "effect-codex-app-server/schema";

export function codexProviderTurnTokenUsage(
  tokenUsage: CodexSchema.V2ThreadTokenUsageUpdatedNotification["tokenUsage"],
  updatedAt: string,
) {
  return {
    usedTokens: Math.max(0, tokenUsage.last.totalTokens),
    maxTokens: tokenUsage.modelContextWindow ?? null,
    inputTokens: Math.max(0, tokenUsage.last.inputTokens),
    cachedInputTokens: Math.max(0, tokenUsage.last.cachedInputTokens),
    outputTokens: Math.max(0, tokenUsage.last.outputTokens),
    reasoningOutputTokens: Math.max(0, tokenUsage.last.reasoningOutputTokens),
    updatedAt,
  };
}
