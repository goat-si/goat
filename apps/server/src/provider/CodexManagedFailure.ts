import type { OrchestrationV2ProviderFailure } from "@goat/contracts";
import { classifyCodexManagedError } from "./CodexManagedErrors.ts";
import { codexUsageLimitResetAt, type CodexRateLimitSnapshot } from "./codexUsageLimits.ts";

/**
 * ChatGPT sharing reports its own reason inside Codex's generic turn error, so
 * the code it names replaces Codex's, and clients pick a recovery from it. Its
 * allowance limits get the usage-limit recovery; other sharing failures keep their class.
 */
export function withCodexManagedFailure(
  failure: OrchestrationV2ProviderFailure,
  nativeError: unknown,
): OrchestrationV2ProviderFailure {
  const managed = classifyCodexManagedError(nativeError);
  return managed === undefined
    ? failure
    : {
        ...failure,
        message: managed.message,
        code: managed.code,
        ...(managed.usageLimit ? { class: "usage_limit" } : {}),
      };
}

export function failureResetAt(
  failure: OrchestrationV2ProviderFailure,
  snapshot: CodexRateLimitSnapshot | undefined,
) {
  // Sharing caps have no reset timestamp in the ordinary Codex allowance snapshot.
  return classifyCodexManagedError(failure.code)?.usageLimit
    ? null
    : codexUsageLimitResetAt(snapshot);
}
