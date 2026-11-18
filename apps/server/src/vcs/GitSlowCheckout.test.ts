import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { makeGitVcsDriverCore } from "./GitVcsDriverCore.ts";
import {
  git,
  initRepoWithCommit,
  layerServerConfig,
  layerTest,
  makeTmpDir,
} from "./testing/gitFixture.ts";

it.layer(layerTest)("slow git checkout", (it) => {
  it.effect("lets a slow remote branch checkout finish without blocking config writes", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      yield* initRepoWithCommit(cwd);
      const remote = yield* makeTmpDir("git-remote-");
      yield* git(remote, ["init", "--bare"]);
      yield* git(cwd, ["remote", "add", "origin", remote]);
      yield* git(cwd, ["push", "origin", "HEAD:refs/heads/feature"]);
      yield* git(cwd, ["fetch", "origin"]);
      const checkoutStarted = yield* Deferred.make<void>();
      const releaseCheckout = yield* Deferred.make<void>();
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      // Holds the real checkout open like a slow LFS smudge filter would.
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          const handle = yield* delegate.spawn(command);
          if (!ChildProcess.isStandardCommand(command) || command.args[0] !== "checkout") {
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

      const switching = yield* driver
        .switchRef({ cwd, refName: "origin/feature" })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(checkoutStarted);
      yield* TestClock.adjust("60 seconds");
      yield* driver.createRef({ cwd, refName: "other" });
      yield* Deferred.succeed(releaseCheckout, undefined);

      const result = yield* Fiber.join(switching);
      assert.equal(result.refName, "feature");
      assert.equal(
        yield* git(cwd, ["rev-parse", "--abbrev-ref", "feature@{upstream}"]),
        "origin/feature",
      );
    }),
  );
});
