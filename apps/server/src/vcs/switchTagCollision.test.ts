import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import { git, initRepoWithCommit, layerTest, makeTmpDir } from "./testing/gitFixture.ts";

it.layer(layerTest)("remote branch switch", (it) => {
  it.effect("selects a tracking branch even when a tag has the same name", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      const remote = yield* makeTmpDir("git-remote-");
      yield* git(remote, ["init", "--bare"]);
      yield* git(cwd, ["remote", "add", "origin", remote]);
      yield* git(cwd, ["push", "origin", "HEAD:refs/heads/v1.2"]);
      yield* git(cwd, ["fetch", "origin"]);
      yield* git(cwd, ["branch", "--track", "v1.2", "origin/v1.2"]);
      yield* git(cwd, ["tag", "v1.2"]);
      assert.equal(yield* git(cwd, ["branch", "--show-current"]), initialBranch);
      const result = yield* (yield* GitVcsDriver.GitVcsDriver).switchRef({
        cwd,
        refName: "origin/v1.2",
      });
      assert.equal(result.refName, "v1.2");
      assert.equal(yield* git(cwd, ["symbolic-ref", "HEAD"]), "refs/heads/v1.2");
    }),
  );
});
