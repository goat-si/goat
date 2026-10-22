import { WS_METHODS } from "@goat/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createAtomCommandScheduler, createEnvironmentRpcCommand } from "./runtime.ts";

export function createHubProxyEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { nodeId: string } }) =>
      JSON.stringify([environmentId, input.nodeId]),
  };
  return {
    prepareNode: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:hub-proxy:prepare-node",
      tag: WS_METHODS.hubProxyPrepareNode,
      scheduler,
      concurrency,
    }),
    enrollNode: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:hub-proxy:enroll-node",
      tag: WS_METHODS.hubProxyEnrollNode,
      scheduler,
      concurrency,
    }),
    unenrollNode: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:hub-proxy:unenroll-node",
      tag: WS_METHODS.hubProxyUnenrollNode,
      scheduler,
      concurrency,
    }),
  };
}
