import type { ModelSelection } from "@goat/contracts";
import { modelSelectionsEqual } from "@goat/shared/model";
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

// Reasoning-effort changes preserve the tokenizer and context window; other changes need fresh telemetry.
export function canReuseCodexContextUsage(previous: ModelSelection, next: ModelSelection): boolean {
  return modelSelectionsEqual(
    {
      ...previous,
      options: (previous.options ?? []).filter((option) => option.id !== "reasoningEffort"),
    },
    { ...next, options: (next.options ?? []).filter((option) => option.id !== "reasoningEffort") },
  );
}
