import { WS_METHODS } from "@goat/contracts";
import type { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

/** Provider sign-in commands, including the removal of a connection that never finished. */
export function createProviderAuthCommands<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    startProviderAuth: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:provider:auth-start",
      tag: WS_METHODS.providerAuthStart,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input]),
      },
    }),
    respondProviderAuth: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:provider:auth-respond",
      tag: WS_METHODS.providerAuthRespond,
    }),
    completeProviderAuth: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:provider:auth-complete",
      tag: WS_METHODS.providerAuthComplete,
    }),
    cancelProviderAuth: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:provider:auth-cancel",
      tag: WS_METHODS.providerAuthCancel,
    }),
    logoutProviderAuth: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:provider:auth-logout",
      tag: WS_METHODS.providerAuthLogout,
    }),
    removeProviderAuthMethod: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:provider:auth-remove-method",
      tag: WS_METHODS.providerAuthRemoveMethod,
    }),
  };
}
