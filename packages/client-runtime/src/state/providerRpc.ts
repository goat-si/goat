import { WS_METHODS } from "@goat/contracts";
import type { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";
/** Commands for provider sign-in state that the settings surface removes. */
export function createProviderRpc<R, E>(runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>) {
  return {
    removeProviderAuthMethod: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:provider:auth-remove-method",
      tag: WS_METHODS.providerAuthRemoveMethod,
    }),
  };
}
