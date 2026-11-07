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
    /** Whether a thread's worktree is present, or was cleaned up and can be restored. */
    threadWorkspaceStatus: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:thread:workspace-status",
      tag: WS_METHODS.threadGetWorkspaceStatus,
      idleTtlMs: 0,
      staleTimeMs: 0,
    }),
    /** Restores a cleaned-up worktree, or starts the thread in a fresh one with { mode: "fresh" }. */
    restoreThreadWorkspace: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:thread:restore-workspace",
      tag: WS_METHODS.threadRestoreWorkspace,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => environmentId + ":" + input.threadId,
      },
    }),
    /** Records that the cleanup preview was shown ("seen") or starts cleanup now ("confirm"). */
    respondWorktreeCleanupPreview: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:respond-worktree-cleanup-preview",
      tag: WS_METHODS.serverRespondWorktreeCleanupPreview,
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
