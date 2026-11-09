import type { OrchestrationV2ProviderRetry } from "@goat/contracts";

import type { MuseRetryScheduled } from "./protocol.ts";

export interface MuseRetryRow {
  readonly method: string;
  readonly nativeId: string;
  readonly retry: OrchestrationV2ProviderRetry;
  readonly cause: string;
  readonly code: string | undefined;
  running: boolean;
}

// Reminder children and other runtime items can start while the model is still retrying.
export const MODEL_OUTPUT_KINDS = new Set(["agentMessage", "reasoning", "toolCall"]);

/**
 * Folds a scheduled retry into its chain: the first attempt opens a row, and a later attempt of
 * the same method updates that row. Muse sends no recovered event, so the caller settles rows.
 */
export function foldMuseRetry(
  rows: ReadonlyArray<MuseRetryRow>,
  method: string,
  retry: MuseRetryScheduled,
): { readonly index: number; readonly row: MuseRetryRow } {
  const cause = retry.httpStatus === undefined ? retry.errorKind : `HTTP ${retry.httpStatus}`;
  const index = retry.attempt > 1 ? rows.findLastIndex((row) => row.method === method) : -1;
  return {
    index,
    row: {
      method,
      nativeId: rows[index]?.nativeId ?? `retry:${retry.sourceRange.first.id}`,
      // Muse counts the first request as attempt 1; GOAT counts retries.
      retry: {
        attempt: retry.attempt,
        maxAttempts: Math.max(1, retry.maxAttempts - 1),
        retryDelayMs: Math.trunc(retry.retryDelayMs),
      },
      cause: retry.reason ?? (cause ? `Model request failed (${cause})` : "Model request failed"),
      code: retry.errorKind,
      running: true,
    },
  };
}
