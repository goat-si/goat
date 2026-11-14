import type { ProviderThreadId } from "@goat/contracts";

export function isThreadEnvironmentLocked(input: {
  readonly messageCount: number;
  readonly hasRuntime: boolean;
  readonly activeProviderThreadId: ProviderThreadId | null;
}): boolean {
  return input.messageCount > 0 || input.hasRuntime || input.activeProviderThreadId !== null;
}
