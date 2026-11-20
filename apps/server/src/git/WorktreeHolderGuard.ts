import { GitCommandError, ThreadId, WORKTREE_HOLDER_SCAN_LIMIT } from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HostProcess from "@goat/shared/HostProcess";
import * as SqlClient from "effect/sql/SqlClient";

const MAX_PATH_ANCESTORS = 256;
const MAX_DISTINCT_PATHS_TO_RESOLVE = WORKTREE_HOLDER_SCAN_LIMIT;
const MAX_RETURNED_HOLDERS = WORKTREE_HOLDER_SCAN_LIMIT;

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

const makeHolderLookup = Effect.fn("WorktreeHolderGuard.make")(function* <E1, E2>(
  readDistinctPaths: Effect.Effect<ReadonlyArray<unknown>, E1>,
  readHolderIds: (paths: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<unknown>, E2>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  return Effect.fn("WorktreeHolderGuard.lookup")(function* (target: string) {
    const refuse = (detail: string, cause?: unknown) =>
      new GitCommandError({
        operation: "ClientWorktrees.remove",
        command: "git worktree remove",
        cwd: target,
        detail,
        ...(cause === undefined ? {} : { cause }),
      });
    const values = yield* readDistinctPaths.pipe(
      Effect.mapError((cause) => refuse("Could not verify worktree holders.", cause)),
    );
    if (values.some((value) => typeof value !== "string" || !path.isAbsolute(value)))
      return yield* refuse("Could not verify all worktree holders.");
    const paths = [...new Set(values as ReadonlyArray<string>)];
    const unresolved = paths.filter((value) => value !== target);
    if (unresolved.length > MAX_DISTINCT_PATHS_TO_RESOLVE)
      return yield* refuse("Could not verify all worktree holders.");

    const memo = new Map<string, string>();
    const resolve = (value: string, depth: number): ReturnType<typeof fs.realPath> => {
      const cached = memo.get(value);
      if (cached !== undefined) return Effect.succeed(cached);
      return fs.realPath(value).pipe(
        Effect.catch((error) => {
          const parent = path.dirname(value);
          return error.reason._tag === "NotFound" && parent !== value && depth < MAX_PATH_ANCESTORS
            ? resolve(parent, depth + 1).pipe(
                Effect.map((resolved) => path.join(resolved, path.basename(value))),
              )
            : Effect.fail(error);
        }),
        Effect.tap((resolved) => Effect.sync(() => memo.set(value, resolved))),
      );
    };
    const normalize = (value: string) =>
      resolve(path.resolve(value), 0).pipe(
        Effect.map((resolved) => (platform === "linux" ? resolved : resolved.toLowerCase())),
      );
    const matching = paths.includes(target) ? [target] : [];
    if (unresolved.length > 0) {
      const root = yield* normalize(target).pipe(
        Effect.mapError((cause) => refuse("Could not resolve the worktree path.", cause)),
      );
      for (const value of unresolved) {
        const candidate = yield* normalize(value).pipe(
          Effect.mapError((cause) => refuse("Could not resolve a thread worktree path.", cause)),
        );
        if (candidate === root || candidate.startsWith(`${root}${path.sep}`)) matching.push(value);
      }
    }
    if (matching.length === 0) return [];
    const ids = yield* readHolderIds(matching).pipe(
      Effect.mapError((cause) => refuse("Could not verify worktree holders.", cause)),
    );
    if (
      ids.length > MAX_RETURNED_HOLDERS ||
      ids.some((id) => typeof id !== "string" || id.length === 0 || id.trim() !== id)
    )
      return yield* refuse("Could not verify all worktree holders.");
    return (ids as ReadonlyArray<string>).map((id) => ThreadId.make(id));
  });
});

export const makeWorktreeHolderLookup = Effect.fn("WorktreeHolderGuard.makeFromRows")(function* <E>(
  readPaths: Effect.Effect<
    ReadonlyArray<{ readonly id: unknown; readonly worktreePath: unknown }>,
    E
  >,
) {
  return yield* makeHolderLookup(
    readPaths.pipe(Effect.map((rows) => rows.map((row) => row.worktreePath))),
    (paths) =>
      readPaths.pipe(
        Effect.map((rows) =>
          rows
            .filter(
              (row) => typeof row.worktreePath === "string" && paths.includes(row.worktreePath),
            )
            .map((row) => row.id),
        ),
      ),
  );
});

export const makeSqlWorktreeHolderLookup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const paths = sql<{ readonly worktree_path: unknown }>`
    SELECT DISTINCT CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.worktreePath') END AS worktree_path
    FROM orchestration_v2_projection_threads
    WHERE deleted_at IS NULL AND CASE WHEN json_valid(payload_json)
      THEN json_extract(payload_json, '$.worktreePath') IS NOT NULL ELSE 1 END
    LIMIT ${MAX_DISTINCT_PATHS_TO_RESOLVE + 2}
  `.pipe(Effect.map((rows) => rows.map((row) => row.worktree_path)));
  return yield* makeHolderLookup(paths, (matching) =>
    sql<{ readonly thread_id: unknown }>`
    SELECT thread_id FROM orchestration_v2_projection_threads
    WHERE deleted_at IS NULL AND CASE WHEN json_valid(payload_json)
      THEN json_extract(payload_json, '$.worktreePath') IN (SELECT value FROM json_each(${JSON.stringify(matching)})) ELSE 0 END
    LIMIT ${MAX_RETURNED_HOLDERS + 1}
  `.pipe(Effect.map((rows) => rows.map((row) => row.thread_id))),
  );
});
