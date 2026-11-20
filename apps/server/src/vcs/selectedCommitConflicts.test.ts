import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import {
  git,
  initRepoWithCommit,
  layerTest,
  makeTmpDir,
  writeTextFile,
} from "./testing/gitFixture.ts";

it.layer(layerTest)("selected commits with conflicts", (it) => {
  it.effect("preserves unselected conflict stages and hook edits", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* writeTextFile(cwd, "README.md", "stashed version\n");
      yield* git(cwd, ["stash"]);
      yield* writeTextFile(cwd, "README.md", "committed version\n");
      yield* git(cwd, ["commit", "-am", "Change README"]);
      const pop = yield* driver.execute({
        operation: "test.stashPop",
        cwd,
        args: ["stash", "pop"],
        allowNonZeroExit: true,
      });
      assert.equal(pop.exitCode, 1);
      yield* writeTextFile(cwd, "other.txt", "other\n");
      const head = yield* git(cwd, ["rev-parse", "HEAD"]);
      const unmerged = yield* git(cwd, ["ls-files", "--unmerged"]);
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* writeTextFile(
        cwd,
        ".git/hooks/pre-commit",
        "#!/bin/sh\necho formatted >> other.txt\ngit add other.txt\n",
      );
      yield* fs.chmod(path.join(cwd, ".git/hooks/pre-commit"), 0o755);
      yield* driver.commit(cwd, "Add other", "", { stage: { filePaths: ["other.txt"] } });
      assert.equal(yield* git(cwd, ["rev-parse", "HEAD~1"]), head);
      assert.equal(yield* git(cwd, ["show", "--pretty=", "--name-only", "HEAD"]), "other.txt");
      assert.equal(yield* git(cwd, ["show", "HEAD:other.txt"]), "other\nformatted");
      assert.equal(yield* git(cwd, ["show", ":other.txt"]), "other\nformatted");
      assert.equal(yield* git(cwd, ["ls-files", "--unmerged"]), unmerged);
    }),
  );
});
