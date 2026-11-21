import type { OrchestrationV2ProviderCapabilities } from "@goat/contracts";

export const providerSwitchWaitsForTurn = (turns: OrchestrationV2ProviderCapabilities["turns"]) =>
  turns.supportsQueuedMessages &&
  !(turns.supportsInterrupt && turns.supportsSteeringByInterruptRestart);
