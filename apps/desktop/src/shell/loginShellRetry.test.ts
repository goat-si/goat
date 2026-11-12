// @effect-diagnostics nodeBuiltinImport:off -- The desktop fixture replaces the account's shell.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as NodeOS from "node:os";
import { vi } from "vite-plus/test";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopShellEnvironment from "./DesktopShellEnvironment.ts";
import { discoverWithRetries, makeLiveShellProbes } from "./loginShellRetry.ts";

vi.mock("node:os", { spy: true });

const gone = Effect.succeed(true);

const attemptsThat = (succeedOn: number) => {
  const startedAt: number[] = [];
  const attempt = Effect.gen(function* () {
    startedAt.push(yield* Clock.currentTimeMillis);
    return startedAt.length === succeedOn;
  });
  return { startedAt, attempt };
};

describe("login shell discovery retries", () => {
  it.effect("gives up after three more probes, 30 seconds, 2 minutes and 10 minutes apart", () =>
    Effect.gen(function* () {
      const { startedAt, attempt } = attemptsThat(Number.POSITIVE_INFINITY);
      const start = yield* Clock.currentTimeMillis;
      const fiber = yield* discoverWithRetries(attempt, "darwin", gone).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* TestClock.adjust("1 day");
      assert.isFalse(yield* Fiber.join(fiber));
      assert.deepEqual(
        startedAt.map((at) => at - start),
        [0, 30_000, 150_000, 750_000],
      );
    }).pipe(Effect.provide(Logger.layer([]))),
  );

  it.effect("stops probing at the first success", () =>
    Effect.gen(function* () {
      const { startedAt, attempt } = attemptsThat(2);
      const fiber = yield* discoverWithRetries(attempt, "linux", gone).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* TestClock.adjust("1 day");
      assert.isTrue(yield* Fiber.join(fiber));
      assert.equal(startedAt.length, 2);
    }),
  );

  it.effect("keeps Windows at its single probe", () =>
    Effect.gen(function* () {
      const { startedAt, attempt } = attemptsThat(Number.POSITIVE_INFINITY);
      assert.isFalse(yield* discoverWithRetries(attempt, "win32", gone));
      assert.equal(startedAt.length, 1);
    }),
  );

  it.effect("never probes again while an earlier probe's process is not known to be gone", () =>
    Effect.gen(function* () {
      const { startedAt, attempt } = attemptsThat(2);
      const fiber = yield* discoverWithRetries(attempt, "darwin", Effect.succeed(false)).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* TestClock.adjust("1 day");
      assert.isFalse(yield* Fiber.join(fiber));
      assert.equal(startedAt.length, 1);
    }).pipe(Effect.provide(Logger.layer([]))),
  );

  it.effect("probes again when the earlier process is gone by the time the next probe is due", () =>
    Effect.gen(function* () {
      const { startedAt, attempt } = attemptsThat(2);
      const start = yield* Clock.currentTimeMillis;
      const goneAfter20Seconds = Clock.currentTimeMillis.pipe(
        Effect.map((now) => now - start >= 20_000),
      );
      const fiber = yield* discoverWithRetries(attempt, "darwin", goneAfter20Seconds).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* TestClock.adjust("1 day");
      assert.isTrue(yield* Fiber.join(fiber));
      assert.deepEqual(
        startedAt.map((at) => at - start),
        [0, 30_000],
      );
    }),
  );

  it.effect("counts a probe as live until it has finished, cleanup included", () =>
    Effect.gen(function* () {
      const probes = yield* makeLiveShellProbes;
      const exited = yield* Deferred.make<void>();
      assert.isTrue(yield* probes.allGone);
      const probe = yield* probes
        .track(Effect.never.pipe(Effect.ensuring(Deferred.await(exited))))
        .pipe(Effect.forkChild({ startImmediately: true }));
      assert.isFalse(yield* probes.allGone);

      // Timed out and killed, but the process has not exited yet.
      const killing = yield* Fiber.interrupt(probe).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      assert.isFalse(yield* probes.allGone);
      yield* Deferred.succeed(exited, undefined);
      yield* Fiber.join(killing);
      assert.isTrue(yield* probes.allGone);
    }),
  );

  it.effect("counts a spawned process until its exit is observed, after its probe has ended", () =>
    Effect.gen(function* () {
      const probes = yield* makeLiveShellProbes;
      const exited = yield* Deferred.make<void>();
      const handle = { isRunning: Effect.map(Deferred.isDone(exited), (done) => !done) };

      // The probe and its cleanup are over, as after a termination that failed and was ignored.
      yield* probes.track(probes.spawned(Effect.succeed(handle)));
      assert.isFalse(yield* probes.allGone);
      assert.isFalse(yield* probes.allGone);

      yield* Deferred.succeed(exited, undefined);
      assert.isTrue(yield* probes.allGone);
    }),
  );

  it.effect(
    "does not count a spawn that failed, and never takes an unreadable process as gone",
    () =>
      Effect.gen(function* () {
        const probes = yield* makeLiveShellProbes;
        const unreadable = PlatformError.systemError({
          _tag: "Unknown",
          module: "ChildProcess",
          method: "isRunning",
        });
        const failedSpawn: Effect.Effect<ChildProcessSpawner.ChildProcessHandle, string> =
          Effect.fail("spawn failed");
        yield* probes.track(probes.spawned(failedSpawn)).pipe(Effect.ignore);
        assert.isTrue(yield* probes.allGone);

        yield* probes.spawned(Effect.succeed({ isRunning: Effect.fail(unreadable) }));
        assert.isFalse(yield* probes.allGone);
      }),
  );

  it.effect(
    "never reads as gone once a probe was interrupted while the spawner was acquiring its shell",
    () =>
      Effect.gen(function* () {
        const probes = yield* makeLiveShellProbes;
        const acquired = yield* Deferred.make<void>();
        const handle = { isRunning: Effect.succeed(true) };
        // Like the Node spawner: the acquisition cannot be interrupted, and a failed
        // termination is ignored, so the cleanup ends with the process still running.
        const spawn = Effect.acquireRelease(
          Deferred.await(acquired).pipe(Effect.as(handle)),
          () => Effect.void,
        );
        const probe = yield* probes
          .track(Effect.scoped(probes.spawned(spawn).pipe(Effect.andThen(Effect.never))))
          .pipe(Effect.forkChild({ startImmediately: true }));
        const interrupting = yield* Fiber.interrupt(probe).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        assert.isFalse(yield* probes.allGone);

        yield* Deferred.succeed(acquired, undefined);
        yield* Fiber.join(interrupting);
        assert.isFalse(yield* probes.allGone);
      }),
  );

  it.effect("does not count a probe that was interrupted before it started", () =>
    Effect.gen(function* () {
      const probes = yield* makeLiveShellProbes;
      let spawns = 0;
      const spawn = Effect.sync(() => {
        spawns++;
        return { isRunning: Effect.succeed(true) };
      });
      const probe = yield* probes.track(probes.spawned(spawn)).pipe(Effect.forkChild);
      yield* Fiber.interrupt(probe);
      assert.equal(spawns, 0);
      assert.isTrue(yield* probes.allGone);
    }),
  );
});

const STANDARD_DIRS = "/test-home/.local/bin:/test-home/.bun/bin:/opt/homebrew/bin:/usr/local/bin";
const RECOVERED_ANSWER = "__GOAT_ENV_PATH_START__\n/recovered/bin\n__GOAT_ENV_PATH_END__";

/** Answers with `output`, or with none never answers and runs until `exited` completes. */
function fakeProcess(
  output: string | undefined,
  exited?: Deferred.Deferred<void>,
): ChildProcessSpawner.ChildProcessHandle {
  const hung = output === undefined;
  const stdout = hung
    ? Stream.never
    : output === ""
      ? Stream.empty
      : Stream.make(new TextEncoder().encode(output));
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(hung ? 124 : 123),
    stdout,
    stderr: Stream.empty,
    all: stdout,
    exitCode: !hung
      ? Effect.succeed(ChildProcessSpawner.ExitCode(0))
      : exited
        ? Deferred.await(exited).pipe(Effect.as(ChildProcessSpawner.ExitCode(143)))
        : Effect.never,
    isRunning: exited ? Effect.map(Deferred.isDone(exited), (done) => !done) : Effect.succeed(hung),
    kill: () => (hung ? Effect.never : Effect.void),
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
}

interface TimedOutShell {
  readonly service: DesktopShellEnvironment.DesktopShellEnvironment["Service"];
  readonly env: NodeJS.ProcessEnv;
  /** How many times the person's zsh has been started. */
  readonly shellProbes: () => number;
}

/**
 * Runs the desktop service on macOS with a zsh whose first probe never answers and whose later
 * probes answer with /recovered/bin, up to the 10 s timeout of the first one. `cleanup` is what
 * the spawner's scope release does for that probe; `exited` is the process's observed exit. With
 * `acquiring`, the spawner does not hand that process back until it completes.
 */
const afterFirstProbeTimesOut = (input: {
  readonly cleanup: Effect.Effect<unknown>;
  readonly exited?: Deferred.Deferred<void>;
  readonly acquiring?: Deferred.Deferred<void>;
  readonly then: (shell: TimedOutShell) => Effect.Effect<void, never, Scope.Scope>;
}) =>
  Effect.gen(function* () {
    const env: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", PATH: "/usr/bin" };
    const firstProbe = yield* Deferred.make<void>();
    let shellProbes = 0;
    const spawner = ChildProcessSpawner.make((command) => {
      if (command._tag !== "StandardCommand" || command.command !== "/bin/zsh")
        return Effect.succeed(fakeProcess(""));
      shellProbes++;
      return shellProbes === 1
        ? Deferred.succeed(firstProbe, undefined).pipe(
            Effect.andThen(
              Effect.acquireRelease(
                (input.acquiring ? Deferred.await(input.acquiring) : Effect.void).pipe(
                  Effect.as(fakeProcess(undefined, input.exited)),
                ),
                () => input.cleanup,
              ),
            ),
          )
        : Effect.succeed(fakeProcess(RECOVERED_ANSWER));
    });
    const environment = Layer.effect(
      DesktopEnvironment.DesktopEnvironment,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return DesktopEnvironment.DesktopEnvironment.of({
          platform: "darwin",
          stateDir: yield* fs.makeTempDirectoryScoped(),
          homeDirectory: "/test-home",
        } as DesktopEnvironment.DesktopEnvironment["Service"]);
      }),
    ).pipe(Layer.provide(NodeServices.layer));
    const program = Effect.gen(function* () {
      const service = yield* DesktopShellEnvironment.DesktopShellEnvironment;
      yield* service.installIntoProcess;
      yield* Deferred.await(firstProbe);
      yield* TestClock.adjust("10 seconds");
      assert.isFalse(yield* service.awaitDiscovery);
      assert.equal(env.PATH, `/usr/bin:${STANDARD_DIRS}`);
      yield* input.then({ service, env, shellProbes: () => shellProbes });
    }).pipe(
      Effect.provide(
        Layer.merge(
          Logger.layer([]),
          DesktopShellEnvironment.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                environment,
                NodeServices.layer,
                Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
              ),
            ),
          ),
        ),
      ),
    );
    yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = process.env;
        process.env = env;
        const account = vi
          .spyOn(NodeOS, "userInfo")
          .mockReturnValue({ ...NodeOS.userInfo(), shell: null });
        return { previous, account };
      }),
      () => program,
      ({ previous, account }) =>
        Effect.sync(() => {
          process.env = previous;
          account.mockRestore();
        }),
    );
  });

const expectNoFurtherProbe = ({ service, env, shellProbes }: TimedOutShell) =>
  Effect.gen(function* () {
    yield* TestClock.adjust("30 seconds");
    assert.equal(shellProbes(), 1);
    yield* TestClock.adjust("1 day");
    assert.equal(shellProbes(), 1);
    const latest = Option.getOrUndefined(yield* Stream.runHead(service.updates));
    assert.isFalse(latest?.discovered);
    assert.equal(env.PATH, `/usr/bin:${STANDARD_DIRS}`);
  });

const expectRecoveredPath = ({ service, env, shellProbes }: TimedOutShell) =>
  Effect.gen(function* () {
    assert.equal(shellProbes(), 2);
    const recovered = yield* service.updates.pipe(
      Stream.filter((snapshot) => snapshot.discovered),
      Stream.runHead,
    );
    assert.equal(
      Option.getOrUndefined(recovered)?.environment.PATH,
      `/recovered/bin:/usr/bin:${STANDARD_DIRS}`,
    );
    assert.equal(env.PATH, `/recovered/bin:/usr/bin:${STANDARD_DIRS}`);
  });

describe("login shell probes after a timed-out shell, through the desktop service", () => {
  it.effect(
    "probes again once a timed-out login shell is gone, and publishes the recovered PATH",
    () =>
      Effect.gen(function* () {
        const exited = yield* Deferred.make<void>();
        yield* afterFirstProbeTimesOut({
          exited,
          // Killed at the timeout, the shell takes 20 s more to exit: late, but before the next
          // probe is due 30 s after the first discovery ended.
          cleanup: Effect.sleep("20 seconds").pipe(
            Effect.andThen(Deferred.succeed(exited, undefined)),
          ),
          then: (shell) =>
            Effect.gen(function* () {
              yield* TestClock.adjust("29 seconds");
              assert.equal(shell.shellProbes(), 1);
              yield* TestClock.adjust("1 second");
              yield* expectRecoveredPath(shell);
            }),
        });
      }),
  );

  it.effect(
    "never starts another probe while a timed-out login shell is not known to be gone",
    () =>
      // The kill never confirms the shell's exit.
      afterFirstProbeTimesOut({ cleanup: Effect.never, then: expectNoFurtherProbe }),
  );

  it.effect(
    "never starts another probe when the kill failed and the timed-out shell is still running",
    () =>
      // The spawner ignores a failed termination: cleanup ends at once and the shell lives on.
      afterFirstProbeTimesOut({ cleanup: Effect.void, then: expectNoFurtherProbe }),
  );

  it.effect(
    "probes again when a shell that survived a failed kill is seen to exit before the retry is due",
    () =>
      Effect.gen(function* () {
        const exited = yield* Deferred.make<void>();
        yield* afterFirstProbeTimesOut({
          exited,
          cleanup: Effect.void,
          then: (shell) =>
            Effect.gen(function* () {
              yield* TestClock.adjust("20 seconds");
              yield* Deferred.succeed(exited, undefined);
              yield* TestClock.adjust("9 seconds");
              assert.equal(shell.shellProbes(), 1);
              yield* TestClock.adjust("1 second");
              yield* expectRecoveredPath(shell);
            }),
        });
      }),
  );

  it.effect(
    "never starts another probe when the timeout came while the shell was being spawned and the kill then failed",
    () =>
      Effect.gen(function* () {
        const acquiring = yield* Deferred.make<void>();
        const cleaned = yield* Deferred.make<void>();
        yield* afterFirstProbeTimesOut({
          acquiring,
          // The failed termination is ignored: cleanup ends and the shell lives on.
          cleanup: Deferred.succeed(cleaned, undefined),
          then: (shell) =>
            Effect.gen(function* () {
              // The spawner hands back a running shell only now, after the timeout.
              yield* Deferred.succeed(acquiring, undefined);
              yield* Deferred.await(cleaned);
              yield* expectNoFurtherProbe(shell);
            }),
        });
      }),
  );
});
