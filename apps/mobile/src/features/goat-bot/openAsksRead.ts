import { createEnvironmentRpcQueryAtomFamily } from "@goat/client-runtime/state/runtime";
import { CHANNEL_GATEWAY_WS_METHODS } from "@goat/contracts";

import { connectionAtomRuntime } from "../../connection/runtime";

// What each bot waits on the person for, across the owner's bots, in one read.
export const openAsks = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:channel:list-open-asks",
  tag: CHANNEL_GATEWAY_WS_METHODS.listOpenAsks,
  staleTimeMs: 2_000,
});
