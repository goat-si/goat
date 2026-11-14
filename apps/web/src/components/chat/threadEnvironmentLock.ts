import type { ProviderThreadId } from "@goat/contracts";

// An imported native session is bound before it has messages or runs, and its cwd is fixed.
export function isThreadEnvironmentLocked(input: {
  readonly messageCount: number;
  readonly hasRuntime: boolean;
  readonly activeProviderThreadId: ProviderThreadId | null;
}): boolean {
  return input.messageCount > 0 || input.hasRuntime || input.activeProviderThreadId !== null;
}
