import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE worktree_snapshots (
    thread_id TEXT NOT NULL, project_id TEXT NOT NULL, workspace_root TEXT NOT NULL,
    worktree_path TEXT NOT NULL, branch TEXT, base_ref TEXT, head_sha TEXT NOT NULL,
    snapshot_ref TEXT NOT NULL UNIQUE, snapshot_sha TEXT NOT NULL, reason TEXT NOT NULL,
    created_at INTEGER NOT NULL, restored_at INTEGER
  )`;
  yield* sql`CREATE INDEX worktree_snapshots_thread_created ON worktree_snapshots(thread_id, created_at DESC)`;
  yield* sql`CREATE INDEX worktree_snapshots_created ON worktree_snapshots(created_at)`;
  yield* sql`CREATE TABLE worktree_cleanup_preview (
    singleton INTEGER PRIMARY KEY DEFAULT 1 CHECK (singleton = 1),
    preview_id TEXT NOT NULL, started_at INTEGER NOT NULL, planned_count INTEGER NOT NULL,
    seen_at INTEGER, acknowledged_count INTEGER, confirmed_at INTEGER, activated_at INTEGER
  )`;
});
