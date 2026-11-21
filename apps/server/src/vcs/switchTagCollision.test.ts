import { assert, it } from "@effect/vitest";
import { GitCommandError } from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { createTrackingBranch } from "./createTrackingBranch.ts";
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
      const clock = yield* Clock.Clock;
      // The config-lock retry's short pauses end at once; git's 30 s timeouts stay on the test clock.
      const pausesEndAtOnce: Clock.Clock = {
        currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
        currentTimeMillis: clock.currentTimeMillis,
        monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
        monotonicTimeNanos: clock.monotonicTimeNanos,
        currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
        currentTimeNanos: clock.currentTimeNanos,
        sleep: (duration) =>
          Duration.isLessThan(duration, Duration.seconds(1)) ? Effect.void : clock.sleep(duration),
      };
      yield* driver
        .switchRef({ cwd, refName: "upstream/feature" })
        .pipe(Effect.provideService(Clock.Clock, pausesEndAtOnce), Effect.flip);
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

  it.effect("removes the untracked branch even when a fetch moves its remote ref", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      const remoteRef = "refs/remotes/origin/feature";
      const original = yield* git(cwd, ["rev-parse", "HEAD"]);
      yield* git(cwd, ["update-ref", remoteRef, original]);
      yield* git(cwd, ["commit", "--allow-empty", "-m", "new remote head"]);
      const fetched = yield* git(cwd, ["rev-parse", "HEAD"]);
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const configureError = new GitCommandError({
        operation: "GitVcsDriver.switchRef.trackRemote",
        command: "git",
        cwd,
        detail: "config locked",
      });

      const error = yield* createTrackingBranch(
        cwd,
        "feature",
        "origin/feature",
        (operation, cwd, args, options) =>
          operation === configureError.operation
            ? driver
                .execute({
                  operation: "test.fetchMovesRemoteTrackingRef",
                  cwd,
                  args: ["update-ref", remoteRef, fetched],
                })
                .pipe(Effect.andThen(Effect.fail(configureError)))
            : driver.execute({ operation, cwd, args, ...options }),
      ).pipe(Effect.flip);

      assert.strictEqual(error, configureError);
      assert.equal(yield* git(cwd, ["rev-parse", remoteRef]), fetched);
      assert.equal(yield* git(cwd, ["branch", "--list", "feature"]), "");
    }),
  );
});
