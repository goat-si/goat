import * as NodeServices from "@effect/platform-node/NodeServices";
// @effect-diagnostics nodeBuiltinImport:off -- remove only the temporary directory owned by this test.
import * as NodeFS from "node:fs";
import { GitCommandError, WORKTREE_HOLDER_SCAN_LIMIT } from "@goat/contracts";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as GitManager from "./GitManager.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";
import { makeSqlWorktreeHolderLookup, makeWorktreeHolderLookup } from "./WorktreeHolderGuard.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";

it.effect("removes with a large unrelated history but refuses an alias holder", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const sql = yield* SqlClient.SqlClient;
    const root = yield* fs.makeTempDirectoryScoped();
    const worktree = path.join(root, "worktree");
    const alias = path.join(root, "alias");
    const other = path.join(root, "other");
    yield* fs.makeDirectory(worktree);
    yield* fs.makeDirectory(other);
    yield* fs.symlink(worktree, alias);
    yield* sql`CREATE TEMP TABLE orchestration_v2_projection_threads (thread_id TEXT, payload_json TEXT, deleted_at TEXT)`;
    yield* sql`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n < ${WORKTREE_HOLDER_SCAN_LIMIT + 1}) INSERT INTO orchestration_v2_projection_threads SELECT 'other-' || n, json_object('worktreePath', ${other}), NULL FROM seq`;
    yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES ('holder', json_object('worktreePath', ${alias}), NULL)`;
    const lookup = yield* makeSqlWorktreeHolderLookup;
    const workflow = yield* GitWorkflowService.make;
    const guard = (target: string) =>
      lookup(target).pipe(
        Effect.flatMap((ids) =>
          ids.length === 0
            ? Effect.void
            : Effect.fail(
                new GitCommandError({
                  operation: "test",
                  command: "git worktree remove",
                  cwd: target,
                  detail: "A thread uses it.",
                }),
              ),
        ),
      );
    const input = { cwd: root, path: worktree, force: true };
    assert.isTrue(
      Result.isFailure(yield* workflow.removeWorktree(input, guard).pipe(Effect.result)),
    );
    assert.isTrue(yield* fs.exists(worktree));
    yield* sql`DELETE FROM orchestration_v2_projection_threads WHERE thread_id = 'holder'`;
    yield* workflow.removeWorktree(input, guard);
    assert.isFalse(yield* fs.exists(worktree));
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NodeSqliteClient.layer({ filename: ":memory:" }),
        Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
          resolve: () => Effect.succeed({ kind: "git" } as never),
        }),
        Layer.mock(GitVcsDriver.GitVcsDriver)({
          removeWorktree: (input) => Effect.sync(() => NodeFS.rmdirSync(input.path)),
        }),
        Layer.mock(GitManager.GitManager)({}),
      ),
    ),
  ),
);

it.effect("a committed binding makes a leased removal refuse", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped();
    const worktree = path.join(root, "worktree");
    yield* fs.makeDirectory(worktree);
    const holders = yield* Ref.make<ReadonlyArray<{ id: string; worktreePath: string }>>([]);
    const lookup = yield* makeWorktreeHolderLookup(Ref.get(holders));
    const workflow = yield* GitWorkflowService.make;
    yield* withWorkspaceLease(worktree, Ref.set(holders, [{ id: "side", worktreePath: worktree }]));
    const result = yield* workflow
      .removeWorktree({ cwd: root, path: worktree, force: true }, (target) =>
        lookup(target).pipe(
          Effect.flatMap((ids) =>
            ids.length
              ? Effect.fail(
                  new GitCommandError({
                    operation: "test",
                    command: "git worktree remove",
                    cwd: target,
                    detail: "A thread uses it.",
                  }),
                )
              : Effect.void,
          ),
        ),
      )
      .pipe(Effect.result);
    assert.isTrue(Result.isFailure(result));
    assert.isTrue(yield* fs.exists(worktree));
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
          resolve: () => Effect.succeed({ kind: "git" } as never),
        }),
        Layer.mock(GitVcsDriver.GitVcsDriver)({ removeWorktree: () => Effect.void }),
        Layer.mock(GitManager.GitManager)({}),
      ),
    ),
  ),
);

it.effect("an alias workspace lease waits for removal and then sees the missing worktree", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped();
    const worktree = path.join(root, "worktree");
    const alias = path.join(root, "alias");
    yield* fs.makeDirectory(worktree);
    yield* fs.symlink(worktree, alias);
    const scanned = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const attempted = yield* Deferred.make<void>();
    const bound = yield* Ref.make(false);
    const workflow = yield* GitWorkflowService.make;
    const removal = yield* workflow
      .removeWorktree({ cwd: root, path: worktree, force: true }, () =>
        Deferred.succeed(scanned, undefined).pipe(Effect.andThen(Deferred.await(release))),
      )
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(scanned);
    const binding = yield* Deferred.succeed(attempted, undefined).pipe(
      Effect.andThen(
        withWorkspaceLease(
          alias,
          fs
            .exists(alias)
            .pipe(
              Effect.flatMap((exists) => (exists ? Ref.set(bound, true) : Effect.fail("missing"))),
            ),
        ),
      ),
      Effect.result,
      Effect.forkChild({ startImmediately: true }),
    );
    yield* Deferred.await(attempted);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(removal);
    assert.isTrue(Result.isFailure(yield* Fiber.join(binding)));
    assert.isFalse(yield* Ref.get(bound));
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
          resolve: () => Effect.succeed({ kind: "git" } as never),
        }),
        Layer.mock(GitVcsDriver.GitVcsDriver)({
          removeWorktree: (input) => Effect.sync(() => NodeFS.rmdirSync(input.path)),
        }),
        Layer.mock(GitManager.GitManager)({}),
      ),
    ),
  ),
);
