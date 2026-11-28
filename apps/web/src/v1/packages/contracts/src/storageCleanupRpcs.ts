import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { ServerSettingsError } from "./settings.ts";
import { StorageCleanupReport } from "./storageCleanupSettings.ts";
import {
  ThreadWorkspaceRestoreError,
  ThreadWorkspaceRestoreInput,
  ThreadWorkspaceRestoreResult,
  ThreadWorkspaceStatus,
  ThreadWorkspaceStatusInput,
} from "./worktreeRetention.ts";

export const STORAGE_CLEANUP_WS_METHODS = {
  serverRunStorageCleanup: "server.runStorageCleanup",
  serverGetStorageCleanupReport: "server.getStorageCleanupReport",
  serverRespondWorktreeCleanupPreview: "server.respondWorktreeCleanupPreview",
  threadGetWorkspaceStatus: "thread.getWorkspaceStatus",
  threadRestoreWorkspace: "thread.restoreWorkspace",
} as const;

export const WsServerRunStorageCleanupRpc = Rpc.make(
  STORAGE_CLEANUP_WS_METHODS.serverRunStorageCleanup,
  {
    payload: Schema.Struct({}),
    success: StorageCleanupReport,
    error: Schema.Union([ServerSettingsError, EnvironmentAuthorizationError]),
  },
);
export const WsServerGetStorageCleanupReportRpc = Rpc.make(
  STORAGE_CLEANUP_WS_METHODS.serverGetStorageCleanupReport,
  {
    payload: Schema.Struct({}),
    success: Schema.NullOr(StorageCleanupReport),
    stream: true,
    error: EnvironmentAuthorizationError,
  },
);
/** "seen" when a client showed the preview notice; "confirm" starts worktree removal now. */
export const WsServerRespondWorktreeCleanupPreviewRpc = Rpc.make(
  STORAGE_CLEANUP_WS_METHODS.serverRespondWorktreeCleanupPreview,
  {
    payload: Schema.Struct({
      previewId: Schema.String,
      response: Schema.Literals(["seen", "confirm"]),
    }),
    success: Schema.NullOr(StorageCleanupReport),
    error: Schema.Union([ServerSettingsError, EnvironmentAuthorizationError]),
  },
);
export const WsThreadGetWorkspaceStatusRpc = Rpc.make(
  STORAGE_CLEANUP_WS_METHODS.threadGetWorkspaceStatus,
  {
    payload: ThreadWorkspaceStatusInput,
    success: ThreadWorkspaceStatus,
    error: EnvironmentAuthorizationError,
  },
);
export const WsThreadRestoreWorkspaceRpc = Rpc.make(
  STORAGE_CLEANUP_WS_METHODS.threadRestoreWorkspace,
  {
    payload: ThreadWorkspaceRestoreInput,
    success: ThreadWorkspaceRestoreResult,
    error: Schema.Union([ThreadWorkspaceRestoreError, EnvironmentAuthorizationError]),
  },
);
