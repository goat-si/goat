import type { Part as OpenCodePart } from "@opencode-ai/sdk/v2";

export type OpenCodeStepUsage = Pick<
  Extract<OpenCodePart, { readonly type: "step-finish" }>,
  "id" | "tokens"
>;

export interface OpenCodeTurnTokenUsageAccumulator {
  readonly partIds: Set<string>;
  readonly promptMessageIds: Set<string>;
  readonly assistantOwnershipByMessageId: Map<string, "owned" | "other" | "unknown">;
  readonly unresolvedStepsByMessageId: Map<string, Map<string, OpenCodeStepUsage>>;
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  hasSubagents: boolean;
  complete: boolean;
}

export function makeOpenCodeTurnTokenUsageAccumulator(): OpenCodeTurnTokenUsageAccumulator {
  return {
    partIds: new Set(),
    promptMessageIds: new Set(),
    assistantOwnershipByMessageId: new Map(),
    unresolvedStepsByMessageId: new Map(),
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    hasSubagents: false,
    complete: true,
  };
}

export function accumulateOpenCodeStepUsage(
  accumulator: OpenCodeTurnTokenUsageAccumulator,
  part: OpenCodeStepUsage,
): void {
  if (accumulator.partIds.has(part.id)) return;
  accumulator.partIds.add(part.id);
  accumulator.inputTokens += part.tokens.input + part.tokens.cache.read + part.tokens.cache.write;
  accumulator.cachedInputTokens += part.tokens.cache.read;
  accumulator.cacheCreationTokens += part.tokens.cache.write;
  accumulator.outputTokens += part.tokens.output + part.tokens.reasoning;
  accumulator.reasoningTokens += part.tokens.reasoning;
}
