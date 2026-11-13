import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import { git, initRepoWithCommit, layerTest, makeTmpDir } from "./testing/gitFixture.ts";

it.layer(layerTest)("generated worktree paths", (it) => {
  it.effect("keeps leftover files and chooses another path", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const worktreesDirectory = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const input = { cwd, path: null, refName: initialBranch, newRefName: "feature/custom-dir" };
      const created = yield* driver.createWorktree(input, { worktreesDirectory });
      yield* git(cwd, ["worktree", "remove", "--force", created.worktree.path]);
      yield* git(cwd, ["branch", "-D", "feature/custom-dir"]);
      yield* fs.makeDirectory(created.worktree.path);
      yield* fs.writeFileString(path.join(created.worktree.path, "notes.txt"), "my notes");
      const recreated = yield* driver.createWorktree(input, { worktreesDirectory });
      assert.notEqual(recreated.worktree.path, created.worktree.path);
      assert.equal(
        yield* git(recreated.worktree.path, ["branch", "--show-current"]),
        "feature/custom-dir",
      );
      assert.deepEqual(yield* fs.readDirectory(created.worktree.path), ["notes.txt"]);
    }),
  );
});
