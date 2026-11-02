export interface ClaudeCacheCreation {
  readonly ephemeral_1h_input_tokens: number;
  readonly ephemeral_5m_input_tokens: number;
}

export function claudePromptCacheTtlMs(
  cacheCreation: ClaudeCacheCreation | null | undefined,
): number | undefined {
  if (!cacheCreation) return undefined;
  if (cacheCreation.ephemeral_1h_input_tokens > 0) return 60 * 60_000;
  if (cacheCreation.ephemeral_5m_input_tokens > 0) return 5 * 60_000;
  return undefined;
}
