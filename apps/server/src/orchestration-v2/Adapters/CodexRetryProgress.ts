import {
  ProviderDriverKind,
  type OrchestrationV2ProviderRetry,
  type ProviderTurnId,
  type TurnItemId,
} from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";

const CODEX_PROVIDER = ProviderDriverKind.make("codex");

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

// Each retry episode after a recovery gets its own row, placed after the turn's progress so far.
export function codexFailureItemKey(context: {
  readonly providerTurnId: ProviderTurnId;
  readonly recoveredProviderRetries?: number;
}): string {
  const key = `terminal-failure:${context.providerTurnId}`;
  return context.recoveredProviderRetries === undefined
    ? key
    : `${key}:${context.recoveredProviderRetries}`;
}

export function codexFailureItemId(context: {
  readonly providerTurnId: ProviderTurnId;
  readonly recoveredProviderRetries?: number;
}): TurnItemId | undefined {
  return context.recoveredProviderRetries === undefined
    ? undefined
    : IdAllocator.derive.turnItemFromProviderItem({
        driver: CODEX_PROVIDER,
        nativeItemId: codexFailureItemKey(context),
      });
}
