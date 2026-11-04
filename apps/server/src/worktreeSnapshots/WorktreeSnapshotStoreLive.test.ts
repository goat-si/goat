import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import { ProjectId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../config.ts";
import migration from "../persistence/Migrations/133_WorktreeSnapshots.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { WorktreeSnapshotStore } from "./WorktreeSnapshotStore.ts";
import * as Live from "./WorktreeSnapshotStoreLive.ts";

const layer = Live.layer.pipe(
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "snapshot-store-" })),
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
  Layer.provideMerge(NodeServices.layer),
);
it.layer(layer)("snapshot ledger", (it) => {
  it.effect(
    "captures refs, skips missing refs, and expires and purges on inclusive boundaries",
    () =>
      Effect.gen(function* () {
        yield* migration;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const sql = yield* SqlClient.SqlClient;
        const store = yield* WorktreeSnapshotStore;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "snapshot-ledger-" });
        const git = (args: string[]) =>
          driver.execute({
            operation: "SnapshotStoreTest.git",
            cwd,
            args: ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args],
          });
        yield* git(["init", "-q"]);
        yield* fs.writeFileString(path.join(cwd, "a"), "base");
        yield* git(["add", "a"]);
        yield* git(["commit", "-qm", "base"]);
        yield* fs.writeFileString(path.join(cwd, "a"), "changed");
        const threadId = ThreadId.make("thread-one");
        const input = {
          threadId,
          projectId: ProjectId.make("project-one"),
          workspaceRoot: cwd,
          worktreePath: cwd,
          branch: null,
          baseRef: null,
          reason: "test",
        };
        const first = yield* store.capture(input);
        assert.equal(
          (yield* git(["rev-parse", first.snapshotRef])).stdout.trim(),
          first.snapshotSha,
        );
        const second = yield* store.capture(input);
        assert.notEqual(first.snapshotRef, second.snapshotRef);
        yield* git(["update-ref", "-d", second.snapshotRef]);
        assert.equal((yield* store.latestForThread(threadId))?.snapshotRef, first.snapshotRef);
        const now = Date.parse(first.createdAt);
        yield* sql`UPDATE worktree_snapshots SET created_at = ${now}`;
        assert.equal(yield* store.expire(now + 86_400_000 - 1, 1), 0);
        assert.equal(yield* store.purgeDeletedThreads(now + 86_400_000 - 1, [threadId]), 0);
        assert.equal(yield* store.purgeDeletedThreads(now + 86_400_000, [threadId]), 2);
        assert.equal((yield* sql`SELECT * FROM worktree_snapshots`).length, 0);
        assert.equal(yield* store.deleteForThread(threadId), 0);
        const third = yield* store.capture(input);
        const created = Date.parse(third.createdAt);
        assert.equal(yield* store.expire(created + 86_400_000 - 1, 1), 0);
        assert.equal(yield* store.expire(created + 86_400_000, 1), 1);
        const fourth = yield* store.capture(input);
        assert.equal((yield* store.latestForThread(threadId))?.snapshotRef, fourth.snapshotRef);
        assert.equal(yield* store.deleteForThread(threadId), 1);
      }),
  );
});
