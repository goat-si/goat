import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { captureWorktreeSnapshot, verifySnapshot } from "./captureSnapshot.ts";

const layer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "snapshot-test-" })),
  Layer.provideMerge(NodeServices.layer),
);
const git = Effect.fn("SnapshotTest.git")(function* (cwd: string, args: string[]) {
  const driver = yield* GitVcsDriver.GitVcsDriver;
  return (yield* driver.execute({
    operation: "SnapshotTest.git",
    cwd,
    args: ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args],
  })).stdout.trim();
});

it.layer(layer)("worktree snapshots", (it) => {
  it.effect("captures staged and working tree contents separately", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "snapshot-repo-" });
      yield* git(cwd, ["init", "-q"]);
      yield* fs.writeFileString(path.join(cwd, "a"), "base");
      yield* git(cwd, ["add", "a"]);
      yield* git(cwd, ["commit", "-qm", "base"]);
      yield* fs.writeFileString(path.join(cwd, "a"), "staged");
      yield* git(cwd, ["add", "a"]);
      yield* fs.writeFileString(path.join(cwd, "a"), "working");
      yield* fs.writeFileString(path.join(cwd, "new"), "untracked");
      const result = yield* captureWorktreeSnapshot({ cwd, threadId: "test", now: 0 });
      assert.strictEqual(yield* git(cwd, ["show", `${result.indexSha}:a`]), "staged");
      assert.strictEqual(yield* git(cwd, ["show", `${result.snapshotSha}:a`]), "working");
      assert.strictEqual(yield* git(cwd, ["show", `${result.snapshotSha}:new`]), "untracked");
      assert.strictEqual(
        yield* git(cwd, ["rev-parse", `${result.snapshotSha}^2`]),
        result.indexSha,
      );
      const snapshotRef = "refs/goat/snapshots/test/one";
      yield* git(cwd, ["update-ref", snapshotRef, result.snapshotSha]);
      yield* verifySnapshot(cwd, { ...result, snapshotRef });
      yield* fs.writeFileString(path.join(cwd, "a"), "later");
      const error = yield* Effect.flip(verifySnapshot(cwd, { ...result, snapshotRef }));
      assert.strictEqual(error.detail, "changed while cleaning up");
    }),
  );
  it.effect("refuses an untracked nested repository, whose files a snapshot cannot hold", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "snapshot-repo-" });
      yield* git(cwd, ["init", "-q"]);
      yield* git(cwd, ["commit", "--allow-empty", "-qm", "base"]);
      const nested = path.join(cwd, "nested");
      yield* fs.makeDirectory(nested);
      yield* git(nested, ["init", "-q"]);
      yield* fs.writeFileString(path.join(nested, "work"), "unpushed");
      yield* git(nested, ["add", "work"]);
      yield* git(nested, ["commit", "-qm", "nested work"]);
      yield* fs.writeFileString(path.join(nested, "draft"), "uncommitted");
      const error = yield* Effect.flip(captureWorktreeSnapshot({ cwd, threadId: "test", now: 0 }));
      assert.include(error.detail, "nested Git repository");
    }),
  );
  it.effect("refuses a committed nested repository that is not a registered submodule", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "snapshot-repo-" });
      yield* git(cwd, ["init", "-q"]);
      const nested = path.join(cwd, "nested");
      yield* fs.makeDirectory(nested);
      yield* git(nested, ["init", "-q"]);
      yield* git(nested, ["commit", "--allow-empty", "-qm", "nested base"]);
      yield* git(cwd, ["add", "nested"]);
      yield* git(cwd, ["commit", "-qm", "embed"]);
      yield* fs.writeFileString(path.join(nested, "work"), "unpushed");
      yield* git(nested, ["add", "work"]);
      yield* git(nested, ["commit", "-qm", "nested work"]);
      yield* fs.writeFileString(path.join(nested, "draft"), "uncommitted");
      const error = yield* Effect.flip(captureWorktreeSnapshot({ cwd, threadId: "test", now: 0 }));
      assert.include(error.detail, "nested Git repository");
    }),
  );
  it.effect("refuses intent-to-add entries", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "snapshot-repo-" });
      yield* git(cwd, ["init", "-q"]);
      yield* git(cwd, ["commit", "--allow-empty", "-qm", "base"]);
      yield* fs.writeFileString(path.join(cwd, "new"), "new");
      yield* git(cwd, ["add", "-N", "new"]);
      const error = yield* Effect.flip(captureWorktreeSnapshot({ cwd, threadId: "test", now: 0 }));
      assert.match(error.detail, /intent-to-add/);
    }),
  );
  it.effect("refuses assume-unchanged files and in-progress operations", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "snapshot-repo-" });
      yield* git(cwd, ["init", "-q"]);
      yield* fs.writeFileString(path.join(cwd, "a"), "base");
      yield* git(cwd, ["add", "a"]);
      yield* git(cwd, ["commit", "-qm", "base"]);
      yield* git(cwd, ["update-index", "--assume-unchanged", "a"]);
      const first = yield* Effect.flip(captureWorktreeSnapshot({ cwd, threadId: "test", now: 0 }));
      assert.match(first.detail, /assume-unchanged/);
      yield* git(cwd, ["update-index", "--no-assume-unchanged", "a"]);
      yield* fs.writeFileString(path.join(cwd, ".git", "MERGE_HEAD"), "in progress");
      const second = yield* Effect.flip(captureWorktreeSnapshot({ cwd, threadId: "test", now: 0 }));
      assert.match(second.detail, /operation in progress/);
    }),
  );
});
