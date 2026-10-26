import { WS_METHODS } from "@goat/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/** A machine's disk pressure and the GOAT storage a person can review and clean up there. */
export function createStorageEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    /** What GOAT's own folders hold on that machine, from its last scan of a few minutes. */
    storageUsage: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:storage-usage",
      tag: WS_METHODS.serverGetStorageUsage,
      idleTtlMs: 0,
      staleTimeMs: 60_000,
    }),
    /** Scans that machine's GOAT folders now; pass { rescan: true }. */
    scanStorage: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:scan-storage",
      tag: WS_METHODS.serverGetStorageUsage,
      concurrency: { mode: "singleFlight", key: ({ environmentId }) => environmentId },
    }),
    /** Deletes the confirmed items that are still the ones the person reviewed. */
    cleanUpStorageItems: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:clean-up-storage-items",
      tag: WS_METHODS.serverCleanUpStorageItems,
      concurrency: { mode: "singleFlight", key: ({ environmentId }) => environmentId },
    }),
    /** That machine's free disk space and its disk-only pressure level, as it changes. */
    diskPressure: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:server:disk-pressure",
      tag: WS_METHODS.serverSubscribeDiskPressure,
      idleTtlMs: 0,
    }),
  };
}
