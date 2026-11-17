import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
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

  it.effect("creates the tracking branch at the remote when a tag has the remote ref's name", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      const remote = yield* makeTmpDir("git-remote-");
      yield* git(remote, ["init", "--bare"]);
      yield* git(cwd, ["remote", "add", "origin", remote]);
      yield* git(cwd, ["push", "origin", "HEAD:refs/heads/feature"]);
      yield* git(cwd, ["fetch", "origin"]);
      const remoteHead = yield* git(cwd, ["rev-parse", "refs/remotes/origin/feature"]);
      yield* git(cwd, ["commit", "--allow-empty", "-m", "tagged elsewhere"]);
      yield* git(cwd, ["tag", "origin/feature"]);
      yield* git(cwd, ["reset", "--hard", remoteHead]);
      const result = yield* (yield* GitVcsDriver.GitVcsDriver).switchRef({
        cwd,
        refName: "origin/feature",
      });
      assert.equal(result.refName, "feature");
      assert.equal(yield* git(cwd, ["rev-parse", "refs/heads/feature"]), remoteHead);
      assert.equal(
        yield* git(cwd, ["rev-parse", "--symbolic-full-name", "feature@{upstream}"]),
        "refs/remotes/origin/feature",
      );
      assert.notEqual(yield* git(cwd, ["branch", "--show-current"]), initialBranch);
    }),
  );

  it.effect("leaves no untracked branch behind when the config stays locked during a switch", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const { initialBranch } = yield* initRepoWithCommit(cwd);
      const remote = yield* makeTmpDir("git-remote-");
      yield* git(remote, ["init", "--bare"]);
      yield* git(cwd, ["remote", "add", "upstream", remote]);
      yield* git(cwd, ["push", "upstream", `${initialBranch}:refs/heads/feature`]);
      yield* git(cwd, ["fetch", "upstream"]);
      const fileSystem = yield* FileSystem.FileSystem;
      const lockPath = (yield* Path.Path).join(cwd, ".git", "config.lock");
      yield* fileSystem.writeFileString(lockPath, "");
      const driver = yield* GitVcsDriver.GitVcsDriver;
      // The config-lock retry waits on the real clock before giving up.
      yield* TestClock.withLive(driver.switchRef({ cwd, refName: "upstream/feature" })).pipe(
        Effect.flip,
      );
      assert.equal(yield* git(cwd, ["branch", "--show-current"]), initialBranch);
      assert.equal(yield* git(cwd, ["branch", "--list", "feature"]), "");
      yield* fileSystem.remove(lockPath);
      const switched = yield* driver.switchRef({ cwd, refName: "upstream/feature" });
      assert.equal(switched.refName, "feature");
      assert.equal(
        yield* git(cwd, ["rev-parse", "--abbrev-ref", "feature@{upstream}"]),
        "upstream/feature",
      );
    }),
  );
});
