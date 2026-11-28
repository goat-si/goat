import type { SDKAssistantMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ModelSelection } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  resolveClaudeCatalogContextWindowTokens,
} from "../../provider/ClaudeModelCatalog.ts";
import { claudePromptCacheTtlMs, type ClaudeCacheCreation } from "./claudeCacheTtl.ts";

export function optionalClaudeUsageTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}
// Claude caps the window at the model's context, so a setting at or above it never applies.
// Below that, Claude compacts 33,000 tokens short of the window: Claude Code 2.1.305's
// getContextUsage reports a 150,000 window as a 117,000 threshold, for every catalog model.
const CLAUDE_AUTO_COMPACT_RESERVE_TOKENS = 33_000;
export function claudeAutoCompactThreshold(autoCompactWindow: string, maxTokens: number | null) {
  const windowTokens = Number(autoCompactWindow);
  return windowTokens > 0 && (maxTokens === null || windowTokens < maxTokens)
    ? { autoCompactThreshold: windowTokens - CLAUDE_AUTO_COMPACT_RESERVE_TOKENS }
    : {};
}
export function claudeMessageInputTokens(usage: {
  readonly input_tokens?: number | null | undefined;
  readonly cache_creation_input_tokens?: number | null | undefined;
  readonly cache_read_input_tokens?: number | null | undefined;
}): number {
  return (
    (optionalClaudeUsageTokenCount(usage.input_tokens) ?? 0) +
    (optionalClaudeUsageTokenCount(usage.cache_creation_input_tokens) ?? 0) +
    (optionalClaudeUsageTokenCount(usage.cache_read_input_tokens) ?? 0)
  );
}

function claudeContextWindow(modelSelection: ModelSelection): number | null {
  return (
    resolveClaudeCatalogContextWindowTokens(BUNDLED_CLAUDE_MODEL_CATALOG, modelSelection) ?? null
  );
}
export function claudeProviderTurnTokenUsage(
  usage: {
    readonly iterations?: SDKAssistantMessage["message"]["usage"]["iterations"] | undefined;
    readonly input_tokens?: number | null | undefined;
    readonly cache_creation_input_tokens?: number | null | undefined;
    readonly cache_read_input_tokens?: number | null | undefined;
    readonly cache_creation?: ClaudeCacheCreation | null | undefined;
    readonly output_tokens?: number | null | undefined;
  },
  modelSelection: ModelSelection,
  updatedAt: string,
  autoCompactWindow = "",
  requestedAt?: DateTime.Utc,
  reportedMaxTokens?: number | null,
) {
  // After an advisor call, the response totals can count the same context twice.
  const sample = usage.iterations?.findLast((iteration) => iteration.type === "message") ?? usage;
  const inputTokens = claudeMessageInputTokens(sample);
  const outputTokens = optionalClaudeUsageTokenCount(sample.output_tokens) ?? 0;
  const cachedInputTokens = optionalClaudeUsageTokenCount(sample.cache_read_input_tokens) ?? 0;
  const promptCacheTtlMs = claudePromptCacheTtlMs(usage.cache_creation);
  const maxTokens = reportedMaxTokens ?? claudeContextWindow(modelSelection) ?? null;
  // The cache lifetime starts with the request, not when its response ends.
  const promptCacheExpiresAt =
    promptCacheTtlMs === undefined || requestedAt === undefined
      ? undefined
      : DateTime.formatIso(DateTime.add(requestedAt, { milliseconds: promptCacheTtlMs }));
  return {
    usedTokens: inputTokens + outputTokens,
    maxTokens,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens: 0,
    ...(promptCacheTtlMs === undefined ? {} : { promptCacheTtlMs }),
    ...claudeAutoCompactThreshold(autoCompactWindow, maxTokens),
    ...(promptCacheExpiresAt === undefined ? {} : { promptCacheExpiresAt }),
    updatedAt,
  };
}
export type ClaudeMessageUsage = Parameters<typeof claudeProviderTurnTokenUsage>[0];
// message_delta usage is per-message cumulative; null or absent fields retain message_start values and zeros replace them.
export function mergeClaudeStreamUsage(
  current: ClaudeMessageUsage,
  delta: ClaudeMessageUsage,
): ClaudeMessageUsage {
  return {
    ...current,
    iterations: delta.iterations ?? current.iterations,
    input_tokens:
      optionalClaudeUsageTokenCount(delta.input_tokens) ??
      optionalClaudeUsageTokenCount(current.input_tokens) ??
      0,
    cache_creation_input_tokens:
      optionalClaudeUsageTokenCount(delta.cache_creation_input_tokens) ??
      optionalClaudeUsageTokenCount(current.cache_creation_input_tokens) ??
      null,
    cache_read_input_tokens:
      optionalClaudeUsageTokenCount(delta.cache_read_input_tokens) ??
      optionalClaudeUsageTokenCount(current.cache_read_input_tokens) ??
      null,
    output_tokens:
      optionalClaudeUsageTokenCount(delta.output_tokens) ??
      optionalClaudeUsageTokenCount(current.output_tokens) ??
      0,
  };
}
