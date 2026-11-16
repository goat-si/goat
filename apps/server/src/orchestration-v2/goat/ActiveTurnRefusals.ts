import type { OrchestrationV2Command } from "@goat/contracts";

/** Agent- and client-visible: why a selection change waits for the running turn. */
export const PROVIDER_SELECTION_BUSY =
  "This thread has a turn running, and this provider change would end it. Wait for the turn to finish, or press Stop, then try again.";

/**
 * The refusal for a change that would end the thread's running turn, or undefined when it may
 * proceed. A selection change refuses only when it releases a live provider session.
 */
export function activeTurnRefusal(input: {
  readonly command: OrchestrationV2Command;
  readonly releasesLiveSession: boolean;
  readonly hasActiveRun: boolean;
}): string | undefined {
  if (!input.hasActiveRun) return undefined;
  const { command } = input;
  if (
    (command.type === "thread.model-selection.set" || command.type === "provider.switch") &&
    input.releasesLiveSession
  )
    return PROVIDER_SELECTION_BUSY;
  return undefined;
}
