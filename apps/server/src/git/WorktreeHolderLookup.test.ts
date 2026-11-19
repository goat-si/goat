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
      worktreePath: "/other",
    }));
    const lookup = yield* makeWorktreeHolderLookup(Effect.succeed(rows));
    const error = yield* Effect.flip(lookup("/worktree"));
    assert.include(error.detail, "Could not verify all worktree holders");
  }).pipe(Effect.provide(NodeServices.layer)),
);
