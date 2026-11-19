import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import { ThreadId, WORKTREE_HOLDER_SCAN_LIMIT } from "@goat/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import { makeSqlWorktreeHolderLookup, makeWorktreeHolderLookup } from "./WorktreeHolderGuard.ts";

it.effect("finds a holder despite more than the old limit of unrelated thread rows", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const sql = yield* SqlClient.SqlClient;
    const root = yield* fs.makeTempDirectoryScoped();
    const worktree = path.join(root, "worktree");
    const unrelated = path.join(root, "elsewhere");
    const alias = path.join(root, "alias");
    yield* fs.makeDirectory(worktree);
    yield* fs.makeDirectory(unrelated);
    yield* fs.symlink(worktree, alias);
    yield* sql`CREATE TEMP TABLE orchestration_v2_projection_threads (thread_id TEXT, payload_json TEXT, deleted_at TEXT)`;
    yield* sql`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n < ${WORKTREE_HOLDER_SCAN_LIMIT + 1}) INSERT INTO orchestration_v2_projection_threads SELECT 'other-' || n, json_object('worktreePath', ${unrelated}), NULL FROM seq`;
    yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES ('holder', json_object('worktreePath', ${alias}), NULL)`;
    const lookup = yield* makeSqlWorktreeHolderLookup;
    assert.deepStrictEqual(yield* lookup(worktree), [ThreadId.make("holder")]);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(NodeServices.layer, NodeSqliteClient.layer({ filename: ":memory:" })),
    ),
  ),
);

it.effect("refuses when distinct stored worktree paths exceed the scan limit", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const sql = yield* SqlClient.SqlClient;
    const root = yield* fs.makeTempDirectoryScoped();
    const target = path.join(root, "target");
    yield* fs.makeDirectory(target);
    yield* sql`CREATE TEMP TABLE orchestration_v2_projection_threads (thread_id TEXT, payload_json TEXT, deleted_at TEXT)`;
    yield* sql`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n < ${WORKTREE_HOLDER_SCAN_LIMIT + 1}) INSERT INTO orchestration_v2_projection_threads SELECT 'other-' || n, json_object('worktreePath', ${root} || '/missing-' || n), NULL FROM seq`;
    const lookup = yield* makeSqlWorktreeHolderLookup;
    const error = yield* Effect.flip(lookup(target));
    assert.include(error.detail, "Could not verify all worktree holders");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(NodeServices.layer, NodeSqliteClient.layer({ filename: ":memory:" })),
    ),
  ),
);

it.effect("refuses when the number of matching holders exceeds its own limit", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const sql = yield* SqlClient.SqlClient;
    const root = yield* fs.makeTempDirectoryScoped();
    const target = path.join(root, "target");
    yield* fs.makeDirectory(target);
    yield* sql`CREATE TEMP TABLE orchestration_v2_projection_threads (thread_id TEXT, payload_json TEXT, deleted_at TEXT)`;
    yield* sql`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n < ${WORKTREE_HOLDER_SCAN_LIMIT + 1}) INSERT INTO orchestration_v2_projection_threads SELECT 'holder-' || n, json_object('worktreePath', ${target}), NULL FROM seq`;
    const lookup = yield* makeSqlWorktreeHolderLookup;
    const error = yield* Effect.flip(lookup(target));
    assert.include(error.detail, "Could not verify all worktree holders");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(NodeServices.layer, NodeSqliteClient.layer({ filename: ":memory:" })),
    ),
  ),
);

it.effect("counts an exact path holder without resolving the path on disk", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const lookup = yield* makeWorktreeHolderLookup(
      Effect.succeed([{ id: "holder", worktreePath: "/literal" }]),
    ).pipe(
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.FileSystem.of({
          ...fs,
          realPath: () => fs.realPath("/goat-nonexistent-test-path"),
        }),
      ),
    );
    assert.deepStrictEqual(yield* lookup("/literal"), [ThreadId.make("holder")]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("resolves repeated paths and missing parents only once per scan", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped();
    const target = path.join(root, "target");
    const missingParent = path.join(root, "missing");
    const first = path.join(missingParent, "one");
    const second = path.join(missingParent, "two");
    yield* fs.makeDirectory(target);
    const calls: string[] = [];
    const lookup = yield* makeWorktreeHolderLookup(
      Effect.succeed([
        { id: "one", worktreePath: first },
        { id: "duplicate", worktreePath: first },
        { id: "two", worktreePath: second },
      ]),
    ).pipe(
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.FileSystem.of({
          ...fs,
          realPath: (value) => {
            calls.push(value);
            return fs.realPath(value);
          },
        }),
      ),
    );
    assert.deepStrictEqual(yield* lookup(target), []);
    assert.strictEqual(calls.filter((value) => value === first).length, 1);
    assert.strictEqual(calls.filter((value) => value === missingParent).length, 1);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("finds active, archived and side-chat holders through a path alias", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const sql = yield* SqlClient.SqlClient;
    const root = yield* fs.makeTempDirectoryScoped();
    const worktree = path.join(root, "worktree");
    const alias = path.join(root, "alias");
    yield* fs.makeDirectory(worktree);
    yield* fs.symlink(worktree, alias);
    yield* sql`CREATE TEMP TABLE orchestration_v2_projection_threads (thread_id TEXT, payload_json TEXT, deleted_at TEXT)`;
    const side = JSON.stringify({
      worktreePath: alias,
      sideChatOf: "parent",
      archivedAt: "2020-01-01",
    });
    const deleted = JSON.stringify({ worktreePath: worktree });
    yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES ('side', ${side}, NULL), ('deleted', ${deleted}, 'yes')`;
    const lookup = yield* makeSqlWorktreeHolderLookup;
    assert.deepStrictEqual(yield* lookup(worktree), [ThreadId.make("side")]);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(NodeServices.layer, NodeSqliteClient.layer({ filename: ":memory:" })),
    ),
  ),
);

it.effect("refuses visibly when the holder scan exceeds its bound", () =>
  Effect.gen(function* () {
    const rows = Array.from({ length: WORKTREE_HOLDER_SCAN_LIMIT + 1 }, (_, index) => ({
      id: `thread:${index}`,
      worktreePath: `/other/${index}`,
    }));
    const lookup = yield* makeWorktreeHolderLookup(Effect.succeed(rows));
    const error = yield* Effect.flip(lookup("/worktree"));
    assert.include(error.detail, "Could not verify all worktree holders");
  }).pipe(Effect.provide(NodeServices.layer)),
);
