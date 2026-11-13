// @effect-diagnostics nodeBuiltinImport:off - Verify merge state files remain unchanged.
import * as NodeFS from "node:fs";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import {
  git,
  initRepoWithCommit,
  layerTest,
  makeTmpDir,
  writeTextFile,
} from "./testing/gitFixture.ts";

it.layer(layerTest)("merge conflict markers", (it) => {
  it.effect.each([
    { location: "root", conflict: false },
    { location: "nested", conflict: false },
    { location: "worktree", conflict: false },
    { location: "root", conflict: true },
    { location: "nested", conflict: true },
    { location: "worktree", conflict: true },
  ])(
    "rejects selected-file merge commits without mutation ($location, conflict: $conflict)",
    ({ location, conflict }) =>
      Effect.gen(function* () {
        let cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* git(cwd, ["checkout", "-b", "feature"]);
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        if (conflict) yield* writeTextFile(cwd, "README.md", "feature version\n");
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "Feature"]);
        const featureHead = yield* git(cwd, ["rev-parse", "HEAD"]);
        yield* git(cwd, ["checkout", initialBranch]);
        yield* writeTextFile(cwd, "main.txt", "main\n");
        if (conflict) yield* writeTextFile(cwd, "README.md", "main version\n");
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "Main"]);
        const mainHead = yield* git(cwd, ["rev-parse", "HEAD"]);
        if (location === "worktree") {
          const worktree = path.join(yield* makeTmpDir(), "linked");
          yield* git(cwd, ["worktree", "add", "-b", "linked", worktree]);
          cwd = worktree;
        }
        const merge = yield* driver.execute({
          operation: "test.merge",
          cwd,
          args: ["merge", "--no-commit", "--no-ff", "feature"],
          allowNonZeroExit: true,
        });
        assert.equal(merge.exitCode, conflict ? 1 : 0);
        yield* writeTextFile(cwd, "unrelated.txt", "unrelated\n");
        const commitCwd = location === "nested" ? path.join(cwd, "nested") : cwd;
        yield* fs.makeDirectory(commitCwd, { recursive: true });
        const gitDir = yield* git(cwd, ["rev-parse", "--absolute-git-dir"]);
        const names = ["index", "MERGE_HEAD", "MERGE_MSG", "MERGE_MODE", "ORIG_HEAD"];
        const before = names.map((name) => NodeFS.readFileSync(path.join(gitDir, name)));
        const files = ["README.md", "feature.txt", "main.txt", "unrelated.txt"];
        const contents = files.map((name) => NodeFS.readFileSync(path.join(cwd, name)));
        const unmerged = yield* git(cwd, ["ls-files", "--unmerged"]);

        const result = yield* driver
          .commit(commitCwd, "Partial merge", "", { stage: { filePaths: ["feature.txt"] } })
          .pipe(Effect.result);
        if (Result.isSuccess(result)) {
          const parents = yield* git(cwd, ["show", "-s", "--format=%P", "HEAD"]);
          assert.fail(
            `Selected merge commit succeeded with parents ${parents}; MERGE_HEAD exists: ${NodeFS.existsSync(path.join(gitDir, "MERGE_HEAD"))}`,
          );
        } else {
          assert.include(result.failure.detail, "Cannot commit selected files during a merge");
          assert.include(result.failure.detail, "Commit all files");
        }
        assert.deepEqual(
          names.map((name) => NodeFS.readFileSync(path.join(gitDir, name))),
          before,
        );
        assert.deepEqual(
          files.map((name) => NodeFS.readFileSync(path.join(cwd, name))),
          contents,
        );
        assert.equal(yield* git(cwd, ["rev-parse", "HEAD"]), mainHead);
        assert.equal(yield* git(cwd, ["ls-files", "--unmerged"]), unmerged);

        if (conflict) {
          const unresolved = yield* driver
            .commit(commitCwd, "Unresolved merge", "", { stage: {} })
            .pipe(Effect.result);
          assert.isTrue(Result.isFailure(unresolved), "committed an unresolved conflict");
          assert.equal(yield* git(cwd, ["rev-parse", "HEAD"]), mainHead);
          assert.equal(yield* git(cwd, ["ls-files", "--unmerged"]), unmerged);
          // A lone "=======" is a heading underline, not a conflict boundary.
          yield* writeTextFile(cwd, "README.md", "Heading\n=======\n\nresolved\n");
          assert.isNotNull(yield* driver.prepareCommitContext(commitCwd));
        }
        yield* driver.commit(commitCwd, "Finish merge", "", { stage: {} });
        assert.equal(
          yield* git(cwd, ["show", "-s", "--format=%P", "HEAD"]),
          `${mainHead} ${featureHead}`,
        );
        assert.isFalse(NodeFS.existsSync(path.join(gitDir, "MERGE_HEAD")));
        assert.equal(yield* git(cwd, ["show", "HEAD:feature.txt"]), "feature");
        assert.equal(yield* git(cwd, ["show", "HEAD:unrelated.txt"]), "unrelated");
        if (conflict)
          assert.equal(yield* git(cwd, ["show", "HEAD:README.md"]), "Heading\n=======\n\nresolved");
      }),
  );
});
