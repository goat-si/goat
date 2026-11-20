import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import {
  git,
  initRepoWithCommit,
  layerTest,
  makeTmpDir,
  writeTextFile,
} from "./testing/gitFixture.ts";

it.layer(layerTest)("review diff algorithm", (it) => {
  it.effect("reads Changes totals and review diffs without minimizing", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* git(cwd, ["config", "diff.algorithm", "myers"]);
      // Repeated lines make the default and minimal algorithms choose different edits.
      const lines = Array.from({ length: 2000 }, (_, index) => index);
      yield* writeTextFile(
        cwd,
        "repeated.txt",
        lines.map((index) => `${(index ^ (index >> 3)) % 16}\n`).join(""),
      );
      yield* git(cwd, ["add", "."]);
      yield* git(cwd, ["commit", "-m", "repeated lines"]);
      yield* git(cwd, ["checkout", "-b", "feature/totals"]);
      yield* writeTextFile(
        cwd,
        "repeated.txt",
        lines.map((index) => `${(index ^ (index >> 5)) % 16}\n`).join(""),
      );
      const defaultStat = yield* git(cwd, ["diff", "--numstat", "HEAD", "--"]);
      const minimalStat = yield* git(cwd, ["diff", "--minimal", "--numstat", "HEAD", "--"]);
      assert.notEqual(defaultStat, minimalStat);
      const [insertions, deletions] = defaultStat.split("\t");
      const status = yield* driver.statusDetailsLocal(cwd, { includeBranchChanges: true });
      assert.deepStrictEqual(status.branchChanges, {
        baseRef: initialBranch,
        insertions: Number(insertions),
        deletions: Number(deletions),
      });

      const defaultPatch = yield* git(cwd, [
        "diff",
        "--patch",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "HEAD",
        "--",
      ]);
      const preview = yield* driver.getReviewDiffPreview({ cwd });
      for (const source of preview.sources) {
        assert.deepStrictEqual(source.files, [
          {
            path: "repeated.txt",
            previousPath: null,
            additions: Number(insertions),
            deletions: Number(deletions),
            changeType: "change",
          },
        ]);
        assert.strictEqual(source.diff.trim(), defaultPatch);
      }
    }),
  );
});
