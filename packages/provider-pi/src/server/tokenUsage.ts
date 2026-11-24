import type { OrchestrationV2ProviderTurnTokenUsage } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import { piRecordField as recordField } from "./rpc.ts";
import { nonNegativeInteger } from "./modelContextWindow.ts";

export type PiMessageTokenUsage = Pick<
  OrchestrationV2ProviderTurnTokenUsage,
  "inputTokens" | "cachedInputTokens" | "outputTokens"
>;
export const piMessageTokenUsage = (usage: unknown): PiMessageTokenUsage => {
  const input = nonNegativeInteger(usage, "input");
  const cached = nonNegativeInteger(usage, "cacheRead");
  const output = nonNegativeInteger(usage, "output");
  return {
    ...(input === undefined
      ? {}
      : { inputTokens: input + (cached ?? 0) + (nonNegativeInteger(usage, "cacheWrite") ?? 0) }),
    ...(cached === undefined ? {} : { cachedInputTokens: cached }),
    ...(output === undefined ? {} : { outputTokens: output }),
  };
};

export const tokenUsageFromStats = (
  stats: unknown,
  fallbackUsedTokens: number | null,
  updatedAt: DateTime.Utc,
  messageUsage: PiMessageTokenUsage | undefined,
): OrchestrationV2ProviderTurnTokenUsage | undefined => {
  const contextUsage = recordField(stats, "contextUsage");
  const maxTokens = nonNegativeInteger(contextUsage, "contextWindow");
  const usedTokens = nonNegativeInteger(contextUsage, "tokens") ?? fallbackUsedTokens ?? undefined;
  if (usedTokens === undefined || maxTokens === undefined || maxTokens === 0) return undefined;

  return {
    usedTokens,
    maxTokens,
    ...messageUsage,
    updatedAt: DateTime.formatIso(updatedAt),
  };
};
