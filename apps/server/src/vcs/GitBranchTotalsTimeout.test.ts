import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { makeGitVcsDriverCore } from "./GitVcsDriverCore.ts";
import { makeSuccessfulHandle } from "./testing/configLockRegression.ts";
import {
  git,
  initRepoWithCommit,
  layerServerConfig,
  layerTest,
  makeTmpDir,
  writeTextFile,
} from "./testing/gitFixture.ts";

it.layer(layerTest)("branch totals timeout", (it) => {
  it.effect("back off a timed-out branch diff until it expires or HEAD moves", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir("git-branch-totals-timeout-");
      yield* initRepoWithCommit(cwd);
      yield* git(cwd, ["branch", "-M", "main"]);
      yield* git(cwd, ["checkout", "-b", "feature"]);
      yield* writeTextFile(cwd, "feature.txt", "one\n");
      yield* git(cwd, ["add", "feature.txt"]);
      yield* git(cwd, ["commit", "-m", "feature"]);

      let diffs = 0;
      let hang = true;
      const diffStarted = yield* Queue.unbounded<void>();
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.suspend(() => {
          // Status diffs the working tree against HEAD; the branch totals diff the merge base.
          if (
            !ChildProcess.isStandardCommand(command) ||
            !command.args.includes("diff-index") ||
            command.args.includes("HEAD")
          ) {
            return delegate.spawn(command);
          }
          diffs++;
          if (!hang) return delegate.spawn(command);
          return Queue.offer(diffStarted, undefined).pipe(
            Effect.as(
              ChildProcessSpawner.makeHandle({
                ...makeSuccessfulHandle(""),
                isRunning: Effect.succeed(true),
                exitCode: Effect.never,
              }),
            ),
          );
        }),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provide(layerServerConfig),
      );
      const read = driver.statusDetailsLocal(cwd, { includeBranchChanges: true });

      const first = yield* read.pipe(Effect.forkChild);
      yield* Queue.take(diffStarted);
      yield* TestClock.adjust("30 seconds");
      assert.strictEqual((yield* Fiber.join(first)).branchChanges, undefined);
      assert.strictEqual(diffs, 1);
      hang = false;
      assert.strictEqual((yield* read).branchChanges, undefined);
      assert.strictEqual(diffs, 1, "the same HEAD and base are not diffed within the backoff");

      hang = false;
      yield* TestClock.adjust("1 minute");
      assert.deepStrictEqual((yield* read).branchChanges, {
        baseRef: "main",
        insertions: 1,
        deletions: 0,
      });
      assert.strictEqual(diffs, 2, "it is retried once the backoff passes");

      hang = true;
      const again = yield* read.pipe(Effect.forkChild);
      yield* Queue.take(diffStarted);
      yield* TestClock.adjust("30 seconds");
      yield* Fiber.join(again);
      yield* read;
      assert.strictEqual(diffs, 3);

      hang = false;
      yield* writeTextFile(cwd, "feature.txt", "one\ntwo\n");
      yield* git(cwd, ["commit", "-am", "more"]);
      const status = yield* read;
      assert.strictEqual(diffs, 4, "a new HEAD diffs again within the backoff");
      assert.deepStrictEqual(status.branchChanges, {
        baseRef: "main",
        insertions: 2,
        deletions: 0,
      });
    }),
  );
});

it.layer(layerTest)("branch totals without HEAD", (it) => {
  it.effect("does not cache a timeout against an unborn HEAD", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir("git-unborn-totals-");
      yield* git(cwd, ["init", "-b", "main"]);
      yield* writeTextFile(cwd, "new.txt", "one\n");
      let diffs = 0;
      let hang = true;
      const started = yield* Queue.unbounded<void>();
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.suspend(() => {
          if (
            !ChildProcess.isStandardCommand(command) ||
            !command.args.includes("diff-index") ||
            !command.options.env?.GIT_INDEX_FILE
          )
            return delegate.spawn(command);
          diffs++;
          if (!hang) return delegate.spawn(command);
          return Queue.offer(started, undefined).pipe(
            Effect.as(
              ChildProcessSpawner.makeHandle({
                ...makeSuccessfulHandle(""),
                isRunning: Effect.succeed(true),
                exitCode: Effect.never,
              }),
            ),
          );
        }),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provide(layerServerConfig),
      );
      const read = driver.statusDetailsLocal(cwd, { includeBranchChanges: true });
      const first = yield* read.pipe(Effect.forkChild);
      yield* Queue.take(started);
      yield* TestClock.adjust("30 seconds");
      yield* Fiber.join(first);
      hang = false;
      yield* read;
      assert.isAbove(diffs, 1);
    }),
  );
});
