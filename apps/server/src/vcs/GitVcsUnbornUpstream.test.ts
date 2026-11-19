import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import { layerTest, makeTmpDir, git, initRepoWithCommit } from "./testing/gitFixture.ts";

it.layer(layerTest)("unborn upstream", (it) => {
  it.effect("reports status on unborn HEAD without failing or dropping its upstream", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* driver.initRepo({ cwd });
      const initialBranch = yield* git(cwd, ["symbolic-ref", "--short", "HEAD"]);

      const status = yield* driver.statusDetailsRemote(cwd, { refreshUpstream: false });

      assert.equal(status.isRepo, true);
      assert.equal(status.branch, initialBranch);
      assert.equal(status.hasUpstream, false);
      assert.equal(status.aheadCount, 0);
      assert.equal(status.behindCount, 0);

      const seed = yield* makeTmpDir();
      const remote = yield* makeTmpDir("git-remote-");
      yield* initRepoWithCommit(seed);
      yield* git(remote, ["init", "--bare"]);
      yield* git(seed, ["push", remote, `HEAD:refs/heads/${initialBranch}`]);
      yield* git(cwd, ["remote", "add", "origin", remote]);
      yield* git(cwd, ["fetch", "origin"]);
      yield* git(cwd, ["config", `branch.${initialBranch}.remote`, "origin"]);
      yield* git(cwd, ["config", `branch.${initialBranch}.merge`, `refs/heads/${initialBranch}`]);
      assert.equal((yield* driver.statusDetailsLocal(cwd)).hasUpstream, true);
    }),
  );
});
