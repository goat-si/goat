import { createEnvironmentRpcCommand } from "@goat/client-runtime/state/runtime";
import { WS_METHODS } from "@goat/contracts";
import { connectionAtomRuntime } from "~/connection/runtime";

export const readProviderHostMatrix = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "Read providers on machines",
  tag: WS_METHODS.providerHostMatrix,
});
export const startProviderHostSync = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "Sync provider to machines",
  tag: WS_METHODS.providerHostSyncStart,
});
export const readProviderHostSync = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "Read provider sync progress",
  tag: WS_METHODS.providerHostSyncStatus,
});
export const cancelProviderHostSync = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "Cancel provider sync",
  tag: WS_METHODS.providerHostSyncCancel,
});
