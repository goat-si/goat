import * as Layer from "effect/Layer";

import * as ThreadWorkspace from "./orchestration-v2/goat/ThreadWorkspaceService.ts";
import * as ProjectionStoreV2 from "./orchestration-v2/ProjectionStore.ts";
import * as StorageCleanup from "./storageCleanup.ts";
import * as WorktreeCleanupPreviewStateLive from "./worktreeSnapshots/WorktreeCleanupPreviewStateLive.ts";
import * as WorktreeSnapshotStoreLive from "./worktreeSnapshots/WorktreeSnapshotStoreLive.ts";

/** Storage cleanup with its worktree snapshot ledger, and the restore service clients call. */
export const layer = Layer.mergeAll(
  StorageCleanup.layer.pipe(Layer.provide(WorktreeCleanupPreviewStateLive.layer)),
  ThreadWorkspace.layer,
).pipe(Layer.provide(Layer.merge(ProjectionStoreV2.layer, WorktreeSnapshotStoreLive.layer)));
