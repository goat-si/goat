import {
  WS_METHODS,
  type ServerGetStorageUsageInput,
  type StorageCleanInput,
  type ThreadWorkspaceRestoreInput,
  type ThreadWorkspaceStatusInput,
} from "@goat/contracts";
import * as Effect from "effect/Effect";

import * as HostPressureMonitor from "../fleet/pressure/HostPressureMonitor.ts";
import { ThreadWorkspaceService } from "../orchestration-v2/goat/ThreadWorkspaceService.ts";
import * as DatabaseStorage from "../persistence/DatabaseStorage.ts";
import * as StorageCleanup from "../storageCleanup.ts";
import * as StorageReclaim from "./StorageReclaim.ts";

/** The storage RPCs for one client session, kept here so ws.ts only spreads them in. */
export const storageRpcHandlers = Effect.fn("storageRpcHandlers")(function* (sessionId: string) {
  const reclaim = yield* StorageReclaim.StorageReclaim;
  const pressure = yield* HostPressureMonitor.HostPressureMonitor;
  const databaseStorage = yield* DatabaseStorage.DatabaseStorage;
  const storageCleanup = yield* StorageCleanup.StorageCleanup;
  const workspaces = yield* ThreadWorkspaceService;
  return {
    [WS_METHODS.serverGetDatabaseStorage]: () => databaseStorage.status,
    [WS_METHODS.serverCompactStorage]: () => databaseStorage.compactNow,
    [WS_METHODS.serverGetStorageUsage]: (input: ServerGetStorageUsageInput) =>
      reclaim.usage({ rescan: input.rescan === true }),
    [WS_METHODS.serverCleanUpStorageItems]: (input: StorageCleanInput) =>
      reclaim.clean({ items: input.items, actor: "client:" + sessionId }),
    [WS_METHODS.serverSubscribeDiskPressure]: () => pressure.disk,
    [WS_METHODS.serverRespondWorktreeCleanupPreview]: (input: {
      readonly previewId: string;
      readonly response: "seen" | "confirm";
    }) => storageCleanup.respondPreview(input),
    [WS_METHODS.threadGetWorkspaceStatus]: (input: ThreadWorkspaceStatusInput) =>
      workspaces.status(input.threadId),
    [WS_METHODS.threadRestoreWorkspace]: (input: ThreadWorkspaceRestoreInput) =>
      workspaces.restore(input),
  } as const;
});
