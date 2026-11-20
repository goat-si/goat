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
  readonly input_tokens: number;
  readonly cache_creation_input_tokens?: number | null;
  readonly cache_read_input_tokens?: number | null;
}): number {
  return (
    usage.input_tokens +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0)
  );
}
