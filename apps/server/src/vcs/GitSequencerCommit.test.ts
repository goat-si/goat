// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import {
  layerTest,
  makeTmpDir,
  writeTextFile,
  git,
  initRepoWithCommit,
} from "./testing/gitFixture.ts";

it.layer(layerTest)("sequencer commit safety", (it) => {
  it.effect("rejects selected-file commits during a multi-commit no-commit cherry-pick", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const path = yield* Path.Path;
      yield* writeTextFile(cwd, "a.txt", "base a\n");
      yield* writeTextFile(cwd, "b.txt", "base b\n");
      yield* git(cwd, ["add", "."]);
      yield* git(cwd, ["commit", "-m", "Base"]);
      yield* git(cwd, ["checkout", "-b", "feature"]);
      yield* writeTextFile(cwd, "a.txt", "feature a\n");
      yield* writeTextFile(cwd, "b.txt", "feature b\n");
      yield* git(cwd, ["commit", "-am", "Feature one"]);
      yield* writeTextFile(cwd, "later.txt", "later\n");
      yield* git(cwd, ["add", "."]);
      yield* git(cwd, ["commit", "-m", "Feature two"]);
      yield* git(cwd, ["checkout", initialBranch]);
      yield* writeTextFile(cwd, "a.txt", "main a\n");
      yield* writeTextFile(cwd, "b.txt", "main b\n");
      yield* git(cwd, ["commit", "-am", "Main"]);
      const head = yield* git(cwd, ["rev-parse", "HEAD"]);
      const started = yield* driver.execute({
        operation: "test.sequencer",
        cwd,
        args: ["cherry-pick", "--no-commit", "feature~1", "feature"],
        allowNonZeroExit: true,
      });
      assert.equal(started.exitCode, 1);
      yield* writeTextFile(cwd, "a.txt", "resolved a\n");
      const gitDir = yield* git(cwd, ["rev-parse", "--absolute-git-dir"]);
      assert.isFalse(NodeFS.existsSync(path.join(gitDir, "CHERRY_PICK_HEAD")));
      const names = ["index", "sequencer/todo", "sequencer/head"];
      const before = names.map((name) => NodeFS.readFileSync(path.join(gitDir, name)));

      const error = yield* driver
        .commit(cwd, "Partial", "", { stage: { filePaths: ["a.txt"] } })
        .pipe(Effect.flip);
      assert.include(error.detail, "Cannot commit selected files during a cherry-pick or revert");
      assert.deepEqual(
        names.map((name) => NodeFS.readFileSync(path.join(gitDir, name))),
        before,
      );
      assert.equal(yield* git(cwd, ["rev-parse", "HEAD"]), head);
    }),
  );
});
