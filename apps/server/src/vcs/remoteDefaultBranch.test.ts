import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import { git, initRepoWithCommit, layerTest, makeTmpDir } from "./testing/gitFixture.ts";

it.layer(layerTest)("remote default branch", (it) => {
  it.effect("does not report a default branch the remote deleted after the clone", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const remote = yield* makeTmpDir("git-vcs-driver-origin-");
      yield* initRepoWithCommit(cwd);
      yield* git(remote, ["init", "--bare"]);
      yield* git(cwd, ["branch", "-M", "development"]);
      yield* git(cwd, ["remote", "add", "origin", remote]);
      yield* git(cwd, ["push", "origin", "development", "development:main"]);
      yield* git(cwd, ["remote", "set-head", "origin", "development"]);
      yield* git(remote, ["--git-dir=.", "symbolic-ref", "HEAD", "refs/heads/main"]);
      yield* git(cwd, ["push", "origin", "--delete", "development"]);
      yield* git(cwd, ["fetch", "--prune", "origin"]);

      const driver = yield* GitVcsDriver.GitVcsDriver;
      const defaultBranch = yield* driver.resolveDefaultBranchName(cwd, "origin");

      assert.notEqual(defaultBranch, "development");
      assert.isNull(yield* driver.resolveWorktreeBaseRemote({ cwd, refName: "origin/HEAD" }));
      // The branch list marks its default from the same pointer.
      const { refs } = yield* driver.listRefs({ cwd });
      assert.isFalse(refs.some((ref) => ref.name === "development" && ref.isDefault));
    }),
  );
});
