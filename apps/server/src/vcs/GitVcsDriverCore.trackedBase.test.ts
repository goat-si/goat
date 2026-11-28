import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import {
  layerTest,
  makeTmpDir,
  writeTextFile,
  git,
  initRepoWithCommit,
} from "./testing/gitFixture.ts";

it.layer(layerTest)("GitVcsDriver tracked base", (it) => {
  it.effect("compares a plain recorded base with the remote that base branch tracks", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const fork = yield* makeTmpDir();
      const upstream = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* git(cwd, ["branch", "-M", "main"]);
      yield* git(fork, ["init", "--bare"]);
      yield* git(upstream, ["init", "--bare"]);
      yield* git(cwd, ["remote", "add", "origin", fork]);
      yield* git(cwd, ["remote", "add", "upstream", upstream]);
      yield* git(cwd, ["push", "origin", "main"]);
      yield* writeTextFile(cwd, "upstream.txt", "unrelated upstream work\n");
      yield* git(cwd, ["add", "upstream.txt"]);
      yield* git(cwd, ["commit", "-m", "upstream work"]);
      yield* git(cwd, ["push", "-u", "upstream", "main"]);
      yield* git(cwd, ["checkout", "-b", "feature/from-local-main"]);
      yield* git(cwd, ["config", "branch.feature/from-local-main.t3-merge-base", "main"]);
      yield* writeTextFile(cwd, "feature.txt", "intended branch change\n");
      yield* git(cwd, ["add", "feature.txt"]);
      yield* git(cwd, ["commit", "-m", "feature work"]);

      const status = yield* driver.statusDetailsLocal(cwd, { includeBranchChanges: true });
      assert.deepStrictEqual(status.branchChanges, {
        baseRef: "upstream/main",
        insertions: 1,
        deletions: 0,
      });
      assert.strictEqual(status.aheadCount, 1);
      const preview = yield* driver.getReviewDiffPreview({ cwd });
      const changes = preview.sources.find((source) => source.kind === "branch-range")!;
      assert.strictEqual(changes.baseRef, "upstream/main");
      assert.deepStrictEqual(
        changes.files?.map((file) => file.path),
        ["feature.txt"],
      );
    }),
  );
});
