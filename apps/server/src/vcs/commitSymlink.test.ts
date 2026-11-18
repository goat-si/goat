// @effect-diagnostics nodeBuiltinImport:off - junction fixture models a symlinked project path.
import * as NodeFS from "node:fs";
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

it.layer(layerTest)("selected commit via symlink", (it) => {
  it.effect("prepares and commits the selected path from an aliased subdirectory", () =>
    Effect.gen(function* () {
      const sandbox = yield* makeTmpDir();
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const repo = path.join(sandbox, "repo");
      const nested = path.join(repo, "sub", "dir");
      yield* fs.makeDirectory(nested, { recursive: true });
      yield* initRepoWithCommit(repo);
      const cwd = path.join(sandbox, "link");
      NodeFS.symlinkSync(nested, cwd, "junction");
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const selected = "sub/dir/a.txt";
      yield* writeTextFile(repo, selected, "a\n");
      yield* writeTextFile(repo, "b.txt", "b\n");
      const context = yield* driver.prepareCommitContext(cwd, [selected]);
      assert.include(context?.stagedSummary ?? "", "a.txt");
      assert.notInclude(context?.stagedSummary ?? "", "b.txt");
      assert.equal(yield* git(repo, ["diff", "--cached", "--name-only"]), "");
      yield* driver.commit(cwd, "Add a", "", { stage: { filePaths: [selected] } });
      assert.equal(
        yield* git(repo, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]),
        selected,
      );
      assert.include(yield* git(repo, ["status", "--porcelain"]), "?? b.txt");
    }),
  );
});
