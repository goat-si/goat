import { assert, it } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import {
  git,
  initRepoWithCommit,
  layerTest,
  makeTmpDir,
  writeTextFile,
} from "./testing/gitFixture.ts";

it.layer(layerTest)("commit context temporary objects", (it) => {
  it.effect("reads history through a chain of shared clones", () =>
    Effect.gen(function* () {
      const root = yield* makeTmpDir();
      const fileSystem = yield* FileSystem.FileSystem;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const separator = (yield* HostProcess.Platform) === "win32" ? ";" : ":";
      const seed = `${root}/clone${separator}0`;
      yield* fileSystem.makeDirectory(seed);
      yield* initRepoWithCommit(seed);
      let previous = seed;
      for (let index = 1; index <= 6; index += 1) {
        const next = `${root}/clone-${index}`;
        yield* git(root, ["clone", "--quiet", "--shared", previous, next]);
        previous = next;
      }
      // Six shared clones deep is within Git's alternate limit, not one level deeper.
      yield* writeTextFile(previous, "README.md", "changed\n");
      const chained = yield* driver.prepareCommitContext(previous, ["README.md"]);
      assert.include(chained?.stagedSummary ?? "", "M\tREADME.md");
      assert.include(chained?.stagedPatch ?? "", "-# test");
    }),
  );

  it.effect("leaves no objects behind when no commit follows, in a linked worktree too", () =>
    Effect.gen(function* () {
      const repo = yield* makeTmpDir();
      yield* initRepoWithCommit(repo);
      const linked = `${repo}/linked`;
      yield* git(repo, ["worktree", "add", "--quiet", linked]);
      const driver = yield* GitVcsDriver.GitVcsDriver;

      for (const cwd of [repo, linked]) {
        yield* writeTextFile(cwd, "README.md", `changed in ${cwd}\n`);
        yield* writeTextFile(cwd, "draft.txt", `drafted in ${cwd}\n`);
        const blobs = [
          yield* git(cwd, ["hash-object", "draft.txt"]),
          yield* git(cwd, ["hash-object", "README.md"]),
        ];
        const context = yield* driver.prepareCommitContext(cwd);
        assert.include(context?.stagedPatch ?? "", `+drafted in ${cwd}`);
        assert.include(context?.stagedPatch ?? "", "-# test");
        for (const blob of blobs) {
          const probe = yield* driver.execute({
            operation: "GitVcsDriver.test.git",
            cwd,
            args: ["cat-file", "-e", blob],
            allowNonZeroExit: true,
            timeoutMs: 10_000,
          });
          assert.notEqual(probe.exitCode, 0, `${blob} stayed in the repository`);
        }
      }
    }),
  );
});
