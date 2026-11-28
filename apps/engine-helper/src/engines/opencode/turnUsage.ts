// Adapted from provider-opencode/src/server/turnUsage.ts:43-73 at 916b5ccc1b.
import type { Part } from "@opencode-ai/sdk/v2";

type Step = Extract<Part, { type: "step-finish" }>;
export type Usage = { usedTokens: number; inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningOutputTokens: number };

export function contextUsage(step: Step): Usage | undefined {
  const tokens = step.tokens;
  if (!tokens || !tokens.cache) return undefined;
  const { input, output, reasoning, cache: { read, write } } = tokens;
  if (![input, output, reasoning, read, write].every((value) => Number.isSafeInteger(value) && value >= 0)) return undefined;
  const inputTokens = input + read + write;
  const usedTokens = inputTokens + output;
  if (!Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(usedTokens)) return undefined;
  return { usedTokens, inputTokens, cachedInputTokens: read, outputTokens: output, reasoningOutputTokens: reasoning };
}
