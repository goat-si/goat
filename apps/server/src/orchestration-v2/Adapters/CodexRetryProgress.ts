import type { OrchestrationV2ProviderRetry } from "@goat/contracts";

export function parseCodexRetryProgress(
  message: string,
): Pick<OrchestrationV2ProviderRetry, "attempt" | "maxAttempts"> | null {
  const match = /\b(\d+)\s*\/\s*(\d+)\b/u.exec(message);
  if (match?.[1] === undefined || match[2] === undefined) {
    return null;
  }
  const attempt = Number.parseInt(match[1], 10);
  const maxAttempts = Number.parseInt(match[2], 10);
  if (attempt < 1 || maxAttempts < 1) {
    return null;
  }
  return { attempt, maxAttempts };
}
