import type { OrchestrationV2ProviderTurnTokenUsage } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import { piRecordField as recordField } from "./rpc.ts";
import { nonNegativeInteger } from "./modelContextWindow.ts";

export const tokenUsageFromStats = (
  stats: unknown,
  fallbackUsedTokens: number | null,
  updatedAt: DateTime.Utc,
): OrchestrationV2ProviderTurnTokenUsage | undefined => {
  const contextUsage = recordField(stats, "contextUsage");
  const maxTokens = nonNegativeInteger(contextUsage, "contextWindow");
  const usedTokens = nonNegativeInteger(contextUsage, "tokens") ?? fallbackUsedTokens ?? undefined;
  if (usedTokens === undefined || maxTokens === undefined || maxTokens === 0) return undefined;

  const totals = recordField(stats, "tokens");
  const inputTokens = nonNegativeInteger(totals, "input");
  const cachedInputTokens = nonNegativeInteger(totals, "cacheRead");
  const outputTokens = nonNegativeInteger(totals, "output");
  return {
    usedTokens,
    maxTokens,
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    updatedAt: DateTime.formatIso(updatedAt),
  };
};
