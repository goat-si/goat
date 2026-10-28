// @effect-diagnostics nodeBuiltinImport:off -- The fixture joins its isolated temporary path.
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Sink from "effect/Sink";
import * as TestClock from "effect/testing/TestClock";
import * as FileSystem from "effect/FileSystem";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodePath from "node:path";
import { ChildProcessSpawner } from "effect/process";
import { makeBackendWatchdog, makeRecoveryBudget } from "./DesktopBackendWatchdog.ts";
import * as ElectronPowerMonitor from "../electron/ElectronPowerMonitor.ts";

const makeHealthFixture = Effect.gen(function* () {
  const frames = yield* Queue.unbounded<Uint8Array>();
  const receipts = yield* Queue.unbounded<number>();
  const signals = yield* Queue.unbounded<string>();
  const owner = yield* makeBackendWatchdog(
    {
      protocol: 1,
      generation: "A",
      healthFd: 8,
      onReceipt: (sequence) => {
        Queue.offerUnsafe(receipts, sequence);
      },
    },
    ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(41),
      stdout: Stream.empty,
      stderr: Stream.empty,
      all: Stream.empty,
      exitCode: Effect.never,
      isRunning: Effect.succeed(true),
      kill: (signal) => Queue.offer(signals, signal?.killSignal ?? "SIGTERM").pipe(Effect.asVoid),
      stdin: Sink.drain,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
      unref: Effect.succeed(Effect.void),
    }),
  );
  yield* owner.read(Stream.fromQueue(frames)).pipe(Effect.forkScoped);
  yield* owner.markReady;
  yield* Effect.addFinalizer(() => owner.exitObserved);
  const offer = Effect.fn("test.watchdog.offer")((sequence: number, main: number, silent = false) =>
    Queue.offer(
      frames,
      new TextEncoder().encode(
        JSON.stringify({
          version: 1,
          type: "backendHealth",
          generation: "A",
          observerSequence: sequence,
          mainSequence: main,
          phase: "ready",
          verdict: silent ? "main-silent" : "healthy",
        }) + "\n",
      ),
    ),
  );
  const send = Effect.fn("test.watchdog.send")((sequence: number, main: number, silent = false) =>
    offer(sequence, main, silent).pipe(Effect.andThen(Queue.take(receipts))),
  );
  return { owner, send, offer, signals };
});

it.effect("stale main progress becomes suspect and one advancing beat clears suspicion", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeHealthFixture;
      yield* fixture.send(1, 1);
      for (let sequence = 2; sequence <= 9; sequence++) {
        yield* TestClock.adjust("2 seconds");
        yield* fixture.send(sequence, 1);
      }
      assert.equal(yield* fixture.owner.state, "suspect");
      assert.equal(yield* Queue.size(fixture.signals), 0);
      yield* fixture.send(10, 2);
      assert.equal(yield* fixture.owner.state, "running");
    }),
  ),
);

it.effect("a late terminal verdict cannot signal after its captured run is disarmed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeHealthFixture;
      yield* fixture.owner.disarm;
      yield* fixture.offer(1, 1, true);
      yield* TestClock.adjust("1 minute");
      assert.equal(yield* Queue.size(fixture.signals), 0);
    }),
  ),
);

it.effect("suspend and resume give a committed verdict a fresh observation window", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const listeners = new Map<string, () => void>();
      const power = ElectronPowerMonitor.ElectronPowerMonitor.of({
        isOnBatteryPower: Effect.succeed(false),
        getSystemIdleTime: Effect.succeed(0),
        getSystemIdleState: () => Effect.succeed("active"),
        getCurrentThermalState: Effect.succeed("nominal"),
        onSimpleEvent: (event, listener) =>
          Effect.sync(() => {
            listeners.set(event, listener);
          }),
        onThermalStateChange: () => Effect.void,
        onSpeedLimitChange: () => Effect.void,
      });
      const fixture = yield* makeHealthFixture.pipe(
        Effect.provideService(ElectronPowerMonitor.ElectronPowerMonitor, power),
      );
      listeners.get("suspend")?.();
      yield* fixture.send(1, 1, true);
      yield* TestClock.adjust("1 minute");
      assert.equal(yield* Queue.size(fixture.signals), 0);
      listeners.get("resume")?.();
      yield* TestClock.adjust("44 seconds");
      assert.equal(yield* Queue.size(fixture.signals), 0);
      yield* TestClock.adjust("1 second");
      assert.equal(yield* Queue.take(fixture.signals), "SIGTERM");
    }),
  ),
);

it.effect(
  "transport silence cannot signal; confirmed retirement forces only captured A and blocks without exit",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const frames = yield* Queue.unbounded<Uint8Array>();
        const receipts = yield* Queue.unbounded<number>();
        const signals = yield* Queue.unbounded<string>();
        const blocked = yield* Deferred.make<void>();
        const handle = ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(41),
          stdout: Stream.empty,
          stderr: Stream.empty,
          all: Stream.empty,
          exitCode: Effect.never,
          isRunning: Effect.succeed(true),
          kill: (signal) =>
            Queue.offer(signals, signal?.killSignal ?? "SIGTERM").pipe(
              Effect.andThen(Effect.never),
            ),
          stdin: Sink.drain,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        });
        const owner = yield* makeBackendWatchdog(
          {
            protocol: 1,
            generation: "A",
            healthFd: 8,
            onReceipt: (sequence) => {
              Queue.offerUnsafe(receipts, sequence);
            },
            onState: (state) =>
              state === "blocked"
                ? Deferred.succeed(blocked, undefined).pipe(Effect.asVoid)
                : Effect.void,
          },
          handle,
        );
        yield* owner.read(Stream.fromQueue(frames)).pipe(Effect.forkScoped);
        yield* TestClock.adjust("1 minute");
        assert.equal(yield* Queue.size(signals), 0);
        for (const generation of ["old", "A", "A"]) {
          yield* Queue.offer(
            frames,
            new TextEncoder().encode(
              JSON.stringify({
                version: 1,
                type: "backendHealth",
                generation,
                observerSequence: 1,
                mainSequence: 1,
                phase: "ready",
                verdict: generation === "old" ? "main-silent" : "healthy",
              }) + "\n",
            ),
          );
        }
        assert.equal(yield* Queue.take(receipts), 1);
        yield* Queue.offer(
          frames,
          new TextEncoder().encode(
            JSON.stringify({
              version: 1,
              type: "backendHealth",
              generation: "A",
              observerSequence: 2,
              mainSequence: 1,
              phase: "ready",
              verdict: "main-silent",
            }) + "\n",
          ),
        );
        assert.equal(yield* Queue.take(signals), "SIGTERM");
        yield* TestClock.adjust("5 seconds");
        assert.equal(yield* Queue.take(signals), "SIGKILL");
        yield* TestClock.adjust("5 seconds");
        yield* Deferred.await(blocked);
        assert.equal(yield* owner.state, "blocked");
        yield* owner.exitObserved;
      }),
    ),
);

it.effect(
  "six ready-then-fail generations persist pause across parent construction and manual Retry resets only the record",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-recovery-" });
        const path = NodePath.join(dir, "owner.json");
        const owner = yield* makeRecoveryBudget();
        yield* owner.initialize(path);
        for (let failure = 0; failure < 6; failure++)
          yield* owner.fail(1000 + failure, `run-${failure}`, "exit80");
        assert.equal((yield* owner.current).pause, "crash-loop");
        const next = yield* makeRecoveryBudget();
        yield* next.initialize(path);
        assert.equal((yield* next.current).pause, "crash-loop");
        assert.isTrue(yield* next.reset);
        const retried = yield* makeRecoveryBudget();
        yield* retried.initialize(path);
        assert.equal((yield* retried.current).pause, null);
        assert.deepEqual((yield* retried.current).attempts, []);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("record write failure disables automatic restart", () =>
  Effect.gen(function* () {
    const owner = yield* makeRecoveryBudget();
    yield* owner.initialize("/isolated/owner.json");
    assert.equal((yield* owner.fail(1, "A", "exit80")).pause, "record-unavailable");
  }).pipe(Effect.provide(FileSystem.layerNoop({}))),
);
