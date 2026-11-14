import type { EnvironmentId } from "@goat/contracts";

import { appAtomRegistry } from "../../state/atom-registry";
import { environmentPresentations, useEnvironmentPresentation } from "../../state/presentation";

/** Whether a bot's computer is connected now; bot writes are offered only then. */
export function useGoatBotComputerConnected(environmentId: EnvironmentId | null): boolean {
  return useEnvironmentPresentation(environmentId).presentation?.connection.phase === "connected";
}

/** The same, read when a write runs: a menu opened before a disconnect still sends nothing. */
export function goatBotComputerConnectedNow(environmentId: EnvironmentId): boolean {
  return (
    appAtomRegistry.get(environmentPresentations.presentationAtom(environmentId))?.connection
      .phase === "connected"
  );
}
