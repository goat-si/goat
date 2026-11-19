import { GitCommandError, ThreadId, WORKTREE_HOLDER_SCAN_LIMIT } from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HostProcess from "@goat/shared/HostProcess";
import * as SqlClient from "effect/sql/SqlClient";

const MAX_PATH_ANCESTORS = 256;

export class WorktreeHolderGuard extends Context.Reference<
  (path: string) => Effect.Effect<void, GitCommandError>
>("goat/git/WorktreeHolderGuard", {
  defaultValue: () => (path) =>
    Effect.fail(
      new GitCommandError({
        operation: "ClientWorktrees.remove",
        command: "git worktree remove",
        cwd: path,
        detail: "Cannot verify worktree holders.",
      }),
    ),
}) {}

export const makeWorktreeHolderLookup = Effect.fn("WorktreeHolderGuard.make")(function* <E>(
  readPaths: Effect.Effect<
    ReadonlyArray<{ readonly id: unknown; readonly worktreePath: unknown }>,
    E
  >,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const resolve = (value: string, depth: number): ReturnType<typeof fs.realPath> =>
    fs.realPath(value).pipe(
      Effect.catch((error) => {
        const parent = path.dirname(value);
        return error.reason._tag === "NotFound" && parent !== value && depth < MAX_PATH_ANCESTORS
          ? resolve(parent, depth + 1).pipe(
              Effect.map((resolved) => path.join(resolved, path.basename(value))),
            )
          : Effect.fail(error);
      }),
    );
  const normalize = (value: string) =>
    resolve(path.resolve(value), 0).pipe(
      Effect.map((resolved) => (platform === "linux" ? resolved : resolved.toLowerCase())),
    );
  return Effect.fn("WorktreeHolderGuard.lookup")(function* (target: string) {
    const refuse = (detail: string, cause?: unknown) =>
      new GitCommandError({
        operation: "ClientWorktrees.remove",
        command: "git worktree remove",
        cwd: target,
        detail,
        ...(cause === undefined ? {} : { cause }),
      });
    const rows = yield* readPaths.pipe(
      Effect.mapError((cause) => refuse("Could not verify worktree holders.", cause)),
    );
    if (
      rows.length > WORKTREE_HOLDER_SCAN_LIMIT ||
      rows.some(
        (row) =>
          typeof row.id !== "string" ||
          row.id.length === 0 ||
          row.id.trim() !== row.id ||
          typeof row.worktreePath !== "string" ||
          !path.isAbsolute(row.worktreePath),
      )
    )
      return yield* refuse("Could not verify all worktree holders.");
    const root = yield* normalize(target).pipe(
      Effect.mapError((cause) => refuse("Could not resolve the worktree path.", cause)),
    );
    const holders: ThreadId[] = [];
    for (const row of rows) {
      if (typeof row.id !== "string" || typeof row.worktreePath !== "string") continue;
      const candidate = yield* normalize(row.worktreePath).pipe(
        Effect.mapError((cause) => refuse("Could not resolve a thread worktree path.", cause)),
      );
      if (candidate === root || candidate.startsWith(`${root}${path.sep}`))
        holders.push(ThreadId.make(row.id));
    }
    return holders;
  });
});

export const makeSqlWorktreeHolderLookup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const paths = sql<{ readonly thread_id: unknown; readonly worktree_path: unknown }>`
    SELECT thread_id, CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.worktreePath') END AS worktree_path
    FROM orchestration_v2_projection_threads
    WHERE deleted_at IS NULL AND CASE WHEN json_valid(payload_json)
      THEN json_extract(payload_json, '$.worktreePath') IS NOT NULL ELSE 1 END
    LIMIT ${WORKTREE_HOLDER_SCAN_LIMIT + 1}
  `.pipe(
    Effect.map((rows) =>
      rows.map((row) => ({ id: row.thread_id, worktreePath: row.worktree_path })),
    ),
  );
  return yield* makeWorktreeHolderLookup(paths);
});
