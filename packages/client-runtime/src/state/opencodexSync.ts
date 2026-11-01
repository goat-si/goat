import { WS_METHODS } from "@goat/contracts";
import type { Atom } from "effect/reactivity";

import type * as EnvironmentRegistry from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/**
 * `ocx sync` on an environment and, when it is an OpenCodex Home, on each Child after it. The
 * server runs one sync at a time; its live report carries each machine's progress.
 */
export function createOpenCodexSyncAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
) {
  const perEnvironment = {
    mode: "singleFlight" as const,
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  };
  return {
    planOpenCodexSync: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:plan-opencodex-sync",
      tag: WS_METHODS.serverPlanOpenCodexSync,
      concurrency: perEnvironment,
    }),
    syncOpenCodex: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:sync-opencodex",
      tag: WS_METHODS.serverSyncOpenCodex,
      concurrency: perEnvironment,
    }),
    openCodexSyncLive: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:server:opencodex-sync:live",
      tag: WS_METHODS.serverSubscribeOpenCodexSync,
    }),
  };
}
