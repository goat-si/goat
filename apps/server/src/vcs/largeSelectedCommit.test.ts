import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import { git, layerTest, makeTmpDir } from "./testing/gitFixture.ts";

it.layer(layerTest)("large selected commits", (it) => {
  it.effect("keeps large change sets available for status and commit preparation", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* git(cwd, ["init"]);
      yield* git(cwd, ["config", "user.email", "test@test.com"]);
      yield* git(cwd, ["config", "user.name", "Test"]);
      // Selected paths add up to more than Linux's default 2 MiB argument limit.
      const dir = "d".repeat(200);
      yield* fs.makeDirectory(path.join(cwd, dir));
      const files = Array.from(
        { length: 6_000 },
        (_, index) => `${dir}/file-${String(index).padStart(5, "0")}-${"x".repeat(160)}.txt`,
      );
      yield* Effect.forEach(files, (file) => fs.writeFileString(path.join(cwd, file), "before\n"), {
        concurrency: 16,
        discard: true,
      });
      yield* git(cwd, ["add", "."]);
      const unborn = yield* driver.statusDetailsLocal(cwd);
      assert.lengthOf(unborn.workingTree.files, files.length);
      assert.equal(unborn.workingTree.insertions, files.length);
      const initial = yield* driver.commit(cwd, "initial", "");
      assert.match(initial.commitSha, /^[a-f0-9]{40}$/);
      assert.isFalse((yield* driver.statusDetailsLocal(cwd)).hasWorkingTreeChanges);
      yield* Effect.forEach(files, (file) => fs.writeFileString(path.join(cwd, file), "after\n"), {
        concurrency: 16,
        discard: true,
      });
      const status = yield* driver.statusDetailsLocal(cwd);
      assert.isTrue(status.hasWorkingTreeChanges);
      assert.lengthOf(status.workingTree.files, files.length);
      assert.equal(status.workingTree.insertions, files.length);
      assert.equal(status.workingTree.deletions, files.length);
      const context = yield* driver.prepareCommitContext(cwd, undefined, { includePatch: false });
      assert.isNotNull(context);
      assert.isAbove(context!.stagedSummary.length, 1_000_000);
      assert.lengthOf(context!.stagedSummary.split("\n"), files.length);
      const selected = files.slice(1);
      yield* driver.commit(cwd, "selected", "", { stage: { filePaths: selected } });
      assert.equal(yield* git(cwd, ["log", "-1", "--pretty=%s"]), "selected");
      assert.equal(yield* git(cwd, ["status", "--porcelain"]), `M ${files[0]}`);
    }),
  );
  it.effect("fails with a GitCommandError when spawn throws", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const driver = yield* GitVcsDriver.GitVcsDriver;

      // Over the OS argument limit, Node's spawn throws E2BIG synchronously.
      const error = yield* driver
        .execute({
          operation: "GitVcsDriver.test.spawnThrow",
          cwd,
          args: ["status", "x".repeat(4 * 1024 * 1024)],
        })
        .pipe(Effect.flip);

      assert.deepInclude(error, {
        _tag: "GitCommandError",
        operation: "GitVcsDriver.test.spawnThrow",
        detail: "Failed to spawn Git process.",
      });
    }),
  );
});
