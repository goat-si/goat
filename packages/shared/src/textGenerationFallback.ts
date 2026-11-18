import type { ServerProvider } from "@goat/contracts";

import { appliesToModel, freshWindows, isWindowExhausted, verdictWindows } from "./quotaVerdict.ts";

export function isTextGenerationQuotaExhausted(
  provider: ServerProvider,
  model: string,
  now: number,
): boolean {
  const limits = provider.usageLimits;
  if (limits === undefined) return false;
  return freshWindows(verdictWindows(limits), limits.checkedAt, now).some(
    (window) => appliesToModel(window.scopeModel, model) && isWindowExhausted(window, now),
  );
}
