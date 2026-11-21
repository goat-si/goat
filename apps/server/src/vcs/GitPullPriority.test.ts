// @effect-diagnostics nodeBuiltinImport:off -- compare the spawned process working directory.
import * as NodeFS from "node:fs";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as Tracer from "effect/Tracer";
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

const cloneBehind = Effect.gen(function* () {
  const cwd = yield* makeTmpDir();
  const remote = yield* makeTmpDir();
  const updater = yield* makeTmpDir();
  const { initialBranch } = yield* initRepoWithCommit(cwd);
  yield* git(remote, ["init", "--bare"]);
  yield* git(cwd, ["remote", "add", "origin", remote]);
  yield* git(cwd, ["push", "-u", "origin", initialBranch]);
  yield* git(updater, ["clone", remote, "."]);
  yield* git(updater, ["config", "user.email", "test@test.com"]);
  yield* git(updater, ["config", "user.name", "Test"]);
  yield* writeTextFile(updater, "remote.txt", "remote\n");
  yield* git(updater, ["add", "remote.txt"]);
  yield* git(updater, ["commit", "-m", "remote"]);
  yield* git(updater, ["push", "origin", initialBranch]);
  return { cwd, remoteHead: yield* git(updater, ["rev-parse", "HEAD"]) };
});

it.live.each(["successful", "refused"] as const)(
  "Pull claims a queued fetch when it is %s",
  (mode) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { cwd, remoteHead } = yield* cloneBehind;
        if (mode === "refused") yield* writeTextFile(cwd, "remote.txt", "local data\n");
        const blockers: string[] = [];
        for (let index = 0; index < 4; index++)
          blockers.push(NodeFS.realpathSync.native((yield* cloneBehind).cwd));
        const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
        const release = yield* Deferred.make<void>();
        const blockersStarted = yield* Deferred.make<void>();
        const statusQueued = yield* Deferred.make<void>();
        const waited = yield* Deferred.make<void>();
        const pullStarted = yield* Deferred.make<void>();
        let running = 0;
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            if (ChildProcess.isStandardCommand(command) && command.args.includes("pull"))
              yield* Deferred.succeed(pullStarted, undefined);
            const handle = yield* delegate.spawn(command);
            if (
              ChildProcess.isStandardCommand(command) &&
              command.args.includes("fetch") &&
              blockers.includes(String(command.options.cwd))
            ) {
              if (++running === 4) yield* Deferred.succeed(blockersStarted, undefined);
              yield* Deferred.await(release);
            }
            return handle;
          }),
        );
        const driver = yield* makeGitVcsDriverCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provide(layerServerConfig),
        );
        const tracer = Tracer.make({
          span(options) {
            const span = new Tracer.NativeSpan(options);
            const attribute = span.attribute.bind(span);
            span.attribute = (key, value) => {
              attribute(key, value);
              if (key === "statusFetch.joining") Deferred.doneUnsafe(statusQueued, Effect.void);
              if (key === "statusFetch.waiting") Deferred.doneUnsafe(waited, Effect.void);
            };
            return span;
          },
        });
        yield* Effect.gen(function* () {
          for (const blocker of blockers)
            yield* driver.statusDetailsRemote(blocker).pipe(Effect.forkChild);
          yield* Deferred.await(blockersStarted);
          const status = yield* driver
            .statusDetailsRemote(cwd)
            .pipe(Effect.withTracer(tracer), Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(statusQueued);
          const pull = yield* driver
            .pullCurrentBranch(cwd)
            .pipe(Effect.withTracer(tracer), Effect.forkChild({ startImmediately: true }));
          const outcome = yield* Effect.race(
            Deferred.await(waited).pipe(Effect.as("waited")),
            Deferred.await(pullStarted).pipe(Effect.as("started")),
          );
          assert.strictEqual(outcome, "started");
          const result = yield* Fiber.join(pull).pipe(Effect.result);
          if (mode === "refused") {
            assert.isTrue(Result.isFailure(result));
            yield* Deferred.succeed(release, undefined);
          } else {
            assert.isTrue(Result.isSuccess(result));
            assert.strictEqual(yield* git(cwd, ["rev-parse", "HEAD"]), remoteHead);
          }
          yield* Fiber.join(status);
        }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
      }),
    ).pipe(Effect.provide(layerTest)),
);

it.live("Pull waits for a status fetch already running in the same repository", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { cwd } = yield* cloneBehind;
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const waited = yield* Deferred.make<void>();
      const pullStarted = yield* Deferred.make<void>();
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (ChildProcess.isStandardCommand(command) && command.args.includes("pull"))
            yield* Deferred.succeed(pullStarted, undefined);
          const handle = yield* delegate.spawn(command);
          if (ChildProcess.isStandardCommand(command) && command.args.includes("fetch")) {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
          }
          return handle;
        }),
      );
      const driver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provide(layerServerConfig),
      );
      const tracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options);
          const attribute = span.attribute.bind(span);
          span.attribute = (key, value) => {
            attribute(key, value);
            if (key === "statusFetch.waiting") Deferred.doneUnsafe(waited, Effect.void);
          };
          return span;
        },
      });
      yield* Effect.gen(function* () {
        const status = yield* driver
          .statusDetailsRemote(cwd)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(started);
        const pull = yield* driver
          .pullCurrentBranch(cwd)
          .pipe(Effect.withTracer(tracer), Effect.forkChild({ startImmediately: true }));
        const outcome = yield* Effect.race(
          Deferred.await(waited).pipe(Effect.as("waited")),
          Deferred.await(pullStarted).pipe(Effect.as("started")),
        );
        assert.strictEqual(outcome, "waited");
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(status);
        yield* Fiber.join(pull);
      }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
    }),
  ).pipe(Effect.provide(layerTest)),
);
