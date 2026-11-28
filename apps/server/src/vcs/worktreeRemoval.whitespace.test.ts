// @effect-diagnostics nodeBuiltinImport:off -- junction fixture
import * as NodeFS from "node:fs";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";
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

it.layer(layerTest)("worktree removal metadata", (it) => {
  it.effect("preserves whitespace in Windows metadata paths while keeping junction targets", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const common = path.join(cwd, "metadata\u00a0");
      yield* git(cwd, ["init", "--separate-git-dir", common]);
      const outside = yield* makeTmpDir();
      yield* writeTextFile(outside, "keep.txt", "keep\n");
      const name = "linked\u00a0";
      const worktree = path.join(yield* makeTmpDir(), name);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* driver.createWorktree({
        cwd,
        path: worktree,
        refName: initialBranch,
        newRefName: "feature/linked",
      });
      NodeFS.symlinkSync(outside, path.join(worktree, "shared"), "junction");
      yield* driver
        .removeWorktree({ cwd, path: worktree, force: true })
        .pipe(Effect.provideService(HostProcess.Platform, "win32"));
      assert.isFalse(yield* fs.exists(path.join(common, "worktrees", name)));
      assert.equal(yield* fs.readFileString(path.join(outside, "keep.txt")), "keep\n");
    }),
  );
});
