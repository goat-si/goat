import { WS_METHODS } from "@goat/contracts";
import { Atom } from "effect/reactivity";
import * as EnvironmentRegistry from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createHubMachinesAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
) {
  return {
    hubMachinesList: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:hub-machines:list",
      tag: WS_METHODS.hubMachinesList,
    }),
    hubMachinesAttach: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:hub-machines:attach",
      tag: WS_METHODS.hubMachinesAttach,
    }),
    hubMachinesReissue: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:hub-machines:reissue",
      tag: WS_METHODS.hubMachinesReissue,
    }),
  };
}
