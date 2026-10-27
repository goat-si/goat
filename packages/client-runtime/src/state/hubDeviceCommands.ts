import { WS_METHODS } from "@goat/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

/** Settings → Hub's device commands; web and mobile share them. */
export function createHubDeviceCommands<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    verifyHubDevice: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:hub:device-verify",
      tag: WS_METHODS.hubDeviceVerify,
    }),
    joinHubDevice: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:hub:device-join",
      tag: WS_METHODS.hubDeviceJoin,
    }),
    leaveHubDevice: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:hub:device-leave",
      tag: WS_METHODS.hubDeviceLeave,
    }),
    repairHubDevice: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:hub:device-repair",
      tag: WS_METHODS.hubDeviceRepair,
    }),
    /** A person's standing consent to join an SSH host as the hub's OpenCodex Child. */
    setHubDeviceChildOptIn: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:hub:device-child-opt-in",
      tag: WS_METHODS.hubDeviceChildOptIn,
    }),
  };
}
