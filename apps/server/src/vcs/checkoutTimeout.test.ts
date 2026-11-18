import { assert, it, describe } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { makeGitVcsDriverCore } from "./GitVcsDriverCore.ts";
import {
  git,
  initRepoWithCommit,
  layerServerConfig,
  layerTest,
  makeTmpDir,
  writeTextFile,
} from "./testing/gitFixture.ts";

describe("checkout timeouts", () => {
  const cloneBehindRemote = Effect.gen(function* () {
    const cwd = yield* makeTmpDir();
    const remote = yield* makeTmpDir("git-vcs-driver-remote-");
    const updater = yield* makeTmpDir("git-vcs-driver-updater-");
    const { initialBranch } = yield* initRepoWithCommit(cwd);
    yield* git(remote, ["init", "--bare"]);
    yield* git(cwd, ["remote", "add", "origin", remote]);
    yield* git(cwd, ["push", "-u", "origin", initialBranch]);
    yield* git(updater, ["clone", remote, "."]);
    yield* git(updater, ["config", "user.email", "test@test.com"]);
    yield* git(updater, ["config", "user.name", "Test"]);
    yield* writeTextFile(updater, "remote.txt", "remote\n");
    yield* git(updater, ["add", "remote.txt"]);
    yield* git(updater, ["commit", "-m", "remote commit"]);
    yield* git(updater, ["push", "origin", initialBranch]);
    return {
      cwd,
      remote,
      updater,
      initialBranch,
      remoteHead: yield* git(updater, ["rev-parse", "HEAD"]),
    };
  });

  // A slow smudge filter (LFS) can hold the checkout past 30 seconds; killing it there leaves a
  // half-updated working tree. The automatic pulls and pull request refresh use these defaults.
  it.effect.each(["pull", "merge"] as const)(
    "lets a slow %s checkout finish instead of killing it at 30 seconds",
    (subcommand) =>
      Effect.gen(function* () {
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const { cwd, remoteHead } = yield* cloneBehindRemote;
        yield* git(cwd, ["fetch", "origin"]);
        const checkoutStarted = yield* Deferred.make<void>();
        const releaseCheckout = yield* Deferred.make<void>();
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            const handle = yield* delegate.spawn(command);
            if (!ChildProcess.isStandardCommand(command) || command.args[0] !== subcommand) {
              return handle;
            }
            yield* Deferred.succeed(checkoutStarted, undefined);
            return ChildProcessSpawner.makeHandle({
              ...handle,
              exitCode: Deferred.await(releaseCheckout).pipe(Effect.andThen(handle.exitCode)),
            });
          }),
        );
        const driver = yield* makeGitVcsDriverCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provide(layerServerConfig),
        );

        const move =
          subcommand === "pull"
            ? Effect.asVoid(driver.pullCurrentBranch(cwd))
            : Effect.asVoid(driver.refreshCheckedOutBranch({ cwd, targetCommit: remoteHead }));
        const moving = yield* move.pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(checkoutStarted);
        yield* TestClock.adjust("60 seconds");
        yield* Deferred.succeed(releaseCheckout, undefined);

        yield* Fiber.join(moving);
        assert.equal(yield* git(cwd, ["rev-parse", "HEAD"]), remoteHead);
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect.each(["pull", "merge"] as const)("stops a stalled %s checkout", (subcommand) =>
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const { cwd, remoteHead } = yield* cloneBehindRemote;
      yield* git(cwd, ["fetch", "origin"]);
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          const handle = yield* delegate.spawn(command);
          if (!ChildProcess.isStandardCommand(command) || command.args[0] !== subcommand)
            return handle;
          yield* Deferred.succeed(started, undefined);
          return ChildProcessSpawner.makeHandle({
            ...handle,
            stdout: Stream.empty,
            stderr: Stream.empty,
            exitCode: Deferred.await(release).pipe(Effect.andThen(handle.exitCode)),
          });
        }),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provide(layerServerConfig),
      );
      const move =
        subcommand === "pull"
          ? Effect.asVoid(driver.pullCurrentBranch(cwd))
          : Effect.asVoid(driver.refreshCheckedOutBranch({ cwd, targetCommit: remoteHead }));
      const fiber = yield* move.pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(started);
      yield* TestClock.adjust("3 minutes");
      yield* Deferred.succeed(release, undefined);
      const error = yield* Fiber.join(fiber);
      assert.equal(error.reason, "stalled");
    }).pipe(Effect.provide(layerTest)),
  );
});
