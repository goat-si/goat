import { ThreadId, type WorktreeSnapshot } from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { captureWorktreeSnapshot, verifySnapshot } from "./captureSnapshot.ts";
import { WorktreeSnapshotError, WorktreeSnapshotStore } from "./WorktreeSnapshotStore.ts";

const DAY = 86_400_000;
const encodeThreadIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
type Row = {
  thread_id: string;
  workspace_root: string;
  worktree_path: string;
  branch: string | null;
  base_ref: string | null;
  head_sha: string;
  snapshot_ref: string;
  snapshot_sha: string;
  reason: string;
  created_at: number;
};
const snapshot = (row: Row): WorktreeSnapshot => ({
  threadId: ThreadId.make(row.thread_id),
  worktreePath: row.worktree_path,
  branch: row.branch,
  baseRef: row.base_ref,
  headSha: row.head_sha,
  snapshotRef: row.snapshot_ref,
  snapshotSha: row.snapshot_sha,
  createdAt: DateTime.formatIso(DateTime.makeUnsafe(row.created_at)),
  reason: row.reason,
});
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const run = (cwd: string, args: string[]) =>
    git.execute({ operation: "WorktreeSnapshotStore.git", cwd, args });
  const remove = Effect.fn("WorktreeSnapshotStore.remove")(function* (rows: readonly Row[]) {
    let count = 0;
    for (const row of rows) {
      const deleted = yield* run(row.workspace_root, ["update-ref", "-d", row.snapshot_ref]).pipe(
        Effect.option,
      );
      if (deleted._tag === "None") continue;
      const result = yield* sql<{
        snapshot_ref: string;
      }>`DELETE FROM worktree_snapshots WHERE snapshot_ref = ${row.snapshot_ref} AND snapshot_sha = ${row.snapshot_sha} RETURNING snapshot_ref`.pipe(
        Effect.orDie,
      );
      count += result.length;
    }
    return count;
  });
  return WorktreeSnapshotStore.of({
    capture: Effect.fn("WorktreeSnapshotStore.capture")(function* (input) {
      const now = yield* Clock.currentTimeMillis;
      const captured = yield* captureWorktreeSnapshot({
        cwd: input.worktreePath,
        threadId: input.threadId,
        now,
      }).pipe(
        Effect.provideService(GitVcsDriver.GitVcsDriver, git),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
      const segment = input.threadId.replace(/[^a-zA-Z0-9_-]/g, "_") || "thread";
      const date = DateTime.formatIso(DateTime.makeUnsafe(now))
        .replace(/[-:]/g, "")
        .replace(/\.\d{3}/, "");
      const random = (yield* crypto.randomUUIDv4().pipe(Effect.orDie))
        .replace(/-/g, "")
        .slice(0, 6);
      const ref = `refs/goat/snapshots/${segment}/${date}-${random}`;
      const fail = (cause: unknown) =>
        new WorktreeSnapshotError({
          worktreePath: input.worktreePath,
          detail: "snapshot ledger failed",
          cause,
        });
      yield* run(input.workspaceRoot, ["update-ref", ref, captured.snapshotSha, ""]).pipe(
        Effect.mapError(fail),
      );
      const result = yield* Effect.gen(function* () {
        yield* verifySnapshot(input.worktreePath, { ...captured, snapshotRef: ref }).pipe(
          Effect.provideService(GitVcsDriver.GitVcsDriver, git),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        );
        yield* sql`INSERT INTO worktree_snapshots (thread_id, project_id, workspace_root, worktree_path, branch, base_ref, head_sha, snapshot_ref, snapshot_sha, reason, created_at) VALUES (${input.threadId}, ${input.projectId}, ${input.workspaceRoot}, ${input.worktreePath}, ${input.branch}, ${input.baseRef}, ${captured.headSha}, ${ref}, ${captured.snapshotSha}, ${input.reason}, ${now})`.pipe(
          Effect.mapError(fail),
        );
        return {
          threadId: input.threadId,
          worktreePath: input.worktreePath,
          branch: input.branch,
          baseRef: input.baseRef,
          headSha: captured.headSha,
          snapshotRef: ref,
          snapshotSha: captured.snapshotSha,
          createdAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
          reason: input.reason,
        };
      }).pipe(
        Effect.onError(() =>
          run(input.workspaceRoot, ["update-ref", "-d", ref, captured.snapshotSha]).pipe(
            Effect.ignore,
          ),
        ),
      );
      return result;
    }),
    latestForThread: Effect.fn("WorktreeSnapshotStore.latestForThread")(function* (threadId) {
      const rows =
        yield* sql<Row>`SELECT * FROM worktree_snapshots WHERE thread_id = ${threadId} ORDER BY created_at DESC, rowid DESC`.pipe(
          Effect.orDie,
        );
      for (const row of rows) {
        const ref = yield* run(row.workspace_root, [
          "rev-parse",
          "--verify",
          `${row.snapshot_ref}^{commit}`,
        ]).pipe(Effect.option);
        if (ref._tag === "Some" && ref.value.stdout.trim() === row.snapshot_sha)
          return snapshot(row);
      }
      return null;
    }),
    markRestored: Effect.fn("WorktreeSnapshotStore.markRestored")(function* (ref) {
      const now = yield* Clock.currentTimeMillis;
      yield* sql`UPDATE worktree_snapshots SET restored_at = ${now} WHERE snapshot_ref = ${ref}`.pipe(
        Effect.orDie,
      );
    }),
    deleteForThread: Effect.fn("WorktreeSnapshotStore.deleteForThread")(function* (id) {
      const rows = yield* sql<Row>`SELECT * FROM worktree_snapshots WHERE thread_id = ${id}`.pipe(
        Effect.orDie,
      );
      return yield* remove(rows);
    }),
    expire: Effect.fn("WorktreeSnapshotStore.expire")(function* (now, days) {
      const rows =
        yield* sql<Row>`SELECT * FROM worktree_snapshots WHERE created_at <= ${now - days * DAY}`.pipe(
          Effect.orDie,
        );
      return yield* remove(rows);
    }),
    purgeDeletedThreads: Effect.fn("WorktreeSnapshotStore.purgeDeletedThreads")(
      function* (now, ids) {
        if (ids.length === 0) return 0;
        const rows =
          yield* sql<Row>`SELECT * FROM worktree_snapshots WHERE created_at <= ${now - DAY} AND thread_id IN (SELECT value FROM json_each(${encodeThreadIds(ids)}))`.pipe(
            Effect.orDie,
          );
        return yield* remove(rows);
      },
    ),
  });
});
export const layer = Layer.effect(WorktreeSnapshotStore, make);
