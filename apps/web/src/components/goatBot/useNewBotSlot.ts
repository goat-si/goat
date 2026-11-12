import { newBotSlot, subscribeNewBots } from "@goat/client-runtime/goatBot";
import type { EnvironmentId } from "@goat/contracts";
import { useSyncExternalStore } from "react";

/** The environment's New bot create, and the bots it made that the list may not hold yet. */
export function useNewBotSlot(environmentId: EnvironmentId | null) {
  return useSyncExternalStore(subscribeNewBots, () => newBotSlot(environmentId));
}
