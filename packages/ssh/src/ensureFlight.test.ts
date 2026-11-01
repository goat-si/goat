import { assert, describe, it } from "@effect/vitest";
import type {
  DesktopSshPreparationProgress,
  SshHostStatus,
  SshRuntimePhase,
} from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import { TestClock } from "effect/testing";
import {
  makeEnsureFlights,
  type PreparationAdmission,
  type PreparationReporter,
} from "./ensureFlight.ts";
import { SshLaunchError, SshEnsureSupersededError, SshPreparationTimeoutError } from "./errors.ts";

const fixture = Effect.gen(function* () {
  const scope = yield* Scope.Scope;
  const flights = yield* makeEnsureFlights<number, SshLaunchError>({ scope });
  const entered = yield* Deferred.make<PreparationReporter>();
  const release = yield* Deferred.make<void>();
  const stopped = yield* Deferred.make<void>();
  const admissions = yield* Queue.unbounded<PreparationAdmission>();
  let starts = 0;
  const prepare = (report: PreparationReporter): Effect.Effect<number, SshLaunchError> =>
    Effect.gen(function* () {
      starts++;
      report.onPhase("uploading");
      report.onHostAnswered();
      yield* Deferred.succeed(entered, report);
      yield* Deferred.await(release);
      return starts;
    }).pipe(Effect.ensuring(Deferred.succeed(stopped, undefined)));
  const input = {
    key: "fixture|host|user|22",
    generation: 0,
    intent: "ordinary",
    prepare,
    terminal: () => ({ outcome: "pending" as const }),
    onAdmission: (admission: PreparationAdmission) => {
      Queue.offerUnsafe(admissions, admission);
    },
  };
  const ensure = (
    overrides: Partial<typeof input> & {
      onProgress?: (progress: DesktopSshPreparationProgress) => void;
      onPhase?: PreparationReporter["onPhase"];
      onHostAnswered?: () => void;
    } = {},
  ) => Effect.scoped(flights.join({ ...input, ...overrides }));
  return { flights, entered, release, stopped, admissions, input, ensure, starts: () => starts };
});

describe("manager preparation flights", () => {
  it.effect("replays upload counters to joiners and emits updates within the same phase", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const leader: Array<{ phase: SshRuntimePhase; upload: SshHostStatus["upload"] }> = [];
      const joiner: typeof leader = [];
      const first = yield* f
        .ensure({ onPhase: (phase, upload) => leader.push({ phase, upload }) })
        .pipe(Effect.forkChild);
      const report = yield* Deferred.await(f.entered);
      yield* Queue.take(f.admissions);
      const initial = { sentBytes: 0, totalBytes: 3 * 1024 * 1024 };
      report.onPhase("uploading", initial);
      const second = yield* f
        .ensure({ onPhase: (phase, upload) => joiner.push({ phase, upload }) })
        .pipe(Effect.forkChild);
      assert.equal((yield* Queue.take(f.admissions)).disposition, "join");
      assert.deepEqual(joiner.at(-1), { phase: "uploading", upload: initial });
      const complete = { ...initial, sentBytes: initial.totalBytes };
      report.onPhase("uploading", complete);
      for (const events of [leader, joiner])
        assert.deepEqual(events.at(-1), { phase: "uploading", upload: complete });
      report.onPhase("starting");
      for (const events of [leader, joiner])
        assert.deepEqual(events.at(-1), { phase: "starting", upload: undefined });
      yield* Deferred.succeed(f.release, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "twenty callers at 20/35/60 seconds share work and replay the original remaining budget",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const progress: DesktopSshPreparationProgress[][] = [];
        const callers: Fiber.Fiber<
          { value: number; operationId: string },
          SshLaunchError | SshEnsureSupersededError | SshPreparationTimeoutError
        >[] = [];
        for (let i = 0; i < 20; i++) {
          if (i === 1) yield* TestClock.adjust("20 seconds");
          if (i === 7) yield* TestClock.adjust("15 seconds");
          if (i === 14) yield* TestClock.adjust("25 seconds");
          const events: DesktopSshPreparationProgress[] = [];
          progress.push(events);
          callers.push(
            yield* f.ensure({ onProgress: (event) => events.push(event) }).pipe(Effect.forkChild),
          );
          assert.equal((yield* Queue.take(f.admissions)).disposition, i === 0 ? "leader" : "join");
          yield* Deferred.await(f.entered);
        }
        assert.equal(f.starts(), 1);
        assert.equal(progress[1]![0]!.remainingMs, 880_000);
        assert.equal(progress[7]![0]!.remainingMs, 865_000);
        assert.equal(progress[14]![0]!.remainingMs, 840_000);
        assert.equal(progress[14]![0]!.phase, "uploading");
        assert.isTrue(progress[14]![0]!.hostAnswered);
        yield* Deferred.succeed(f.release, undefined);
        for (const caller of callers) yield* Fiber.join(caller);
        assert.equal(new Set(progress.map((events) => events[0]!.operationId)).size, 1);
        for (const events of progress) assert.equal(events.at(-1)?.outcome, "pending");
      }).pipe(Effect.scoped),
  );

  it.effect("interrupting the leader and every waiter preserves work for a later caller", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      let detachedEvents = 0;
      const first = yield* f.ensure({ onProgress: () => detachedEvents++ }).pipe(Effect.forkChild);
      const report = yield* Deferred.await(f.entered);
      yield* Queue.take(f.admissions);
      yield* Fiber.interrupt(first);
      const before = detachedEvents;
      yield* TestClock.adjust("60 seconds");
      report.onPhase("starting");
      const second = yield* f.ensure().pipe(Effect.forkChild);
      assert.equal((yield* Queue.take(f.admissions)).disposition, "join");
      assert.equal(f.starts(), 1);
      assert.equal(detachedEvents, before);
      yield* Deferred.succeed(f.release, undefined);
      assert.equal((yield* Fiber.join(second)).value, 1);
      // The last completion lease evicts success; there is no persistent result cache.
      assert.equal((yield* f.ensure()).value, 2);
      assert.equal((yield* Queue.take(f.admissions)).disposition, "leader");
    }).pipe(Effect.scoped),
  );

  it.effect(
    "scoped preparation resources belong to the worker until it settles, independent of caller scope",
    () =>
      Effect.gen(function* () {
        const managerScope = yield* Scope.Scope;
        const callerScope = yield* Scope.make();
        const flights = yield* makeEnsureFlights<number, SshLaunchError>({ scope: managerScope });
        const entered = yield* Deferred.make<Scope.Scope>();
        const release = yield* Deferred.make<void>();
        let finalized = 0;
        const input = {
          key: "fixture",
          generation: 0,
          intent: "ordinary",
          terminal: () => ({ outcome: "pending" as const }),
          prepare: () =>
            Effect.gen(function* () {
              const workerScope = yield* Scope.Scope;
              yield* Effect.acquireRelease(Effect.void, () =>
                Effect.sync(() => {
                  finalized++;
                }),
              );
              yield* Deferred.succeed(entered, workerScope);
              yield* Deferred.await(release);
              return 1;
            }),
        };
        const first = yield* flights
          .join(input)
          .pipe(Effect.provideService(Scope.Scope, callerScope), Effect.forkChild);
        const workerScope = yield* Deferred.await(entered);
        assert.notEqual(workerScope, callerScope);
        assert.notEqual(workerScope, managerScope);
        yield* Fiber.interrupt(first);
        yield* Scope.close(callerScope, Exit.void);
        assert.equal(finalized, 0);
        yield* Deferred.succeed(release, undefined);
        const result = yield* Effect.scoped(flights.join(input));
        assert.equal(result.value, 1);
        assert.equal(finalized, 1);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "broken progress, answered, phase and admission observers cannot affect another caller",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const broken = () => {
          throw new Error("detached view");
        };
        const first = yield* f
          .ensure({
            onProgress: broken,
            onPhase: broken,
            onHostAnswered: broken,
            onAdmission: broken,
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(f.entered);
        const second = yield* f.ensure().pipe(Effect.forkChild);
        assert.equal((yield* Queue.take(f.admissions)).disposition, "join");
        yield* Deferred.succeed(f.release, undefined);
        assert.equal((yield* Fiber.join(first)).value, 1);
        assert.equal((yield* Fiber.join(second)).value, 1);
      }).pipe(Effect.scoped),
  );

  it.effect("distinct canonical targets prepare concurrently", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const first = yield* f.ensure().pipe(Effect.forkChild);
      yield* Queue.take(f.admissions);
      const second = yield* f.ensure({ key: "other-alias|host|user|22" }).pipe(Effect.forkChild);
      yield* Queue.take(f.admissions);
      assert.equal(f.starts(), 2);
      yield* Deferred.succeed(f.release, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
    }).pipe(Effect.scoped),
  );

  it.effect("incompatible intent waits for preparation and caller completion leases", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const pairing = yield* Deferred.make<void>();
      const completing = yield* Deferred.make<void>();
      const first = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* f.flights.join(f.input);
          yield* Deferred.succeed(completing, undefined);
          yield* Deferred.await(pairing);
        }),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(f.entered);
      const observed = yield* Deferred.make<void>();
      const second = yield* f
        .ensure({
          intent: "explicit-refresh",
          onProgress: () => {
            Deferred.doneUnsafe(observed, Exit.void);
          },
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(observed);
      yield* Queue.take(f.admissions);
      assert.equal(f.starts(), 1);
      yield* Deferred.succeed(f.release, undefined);
      yield* Deferred.await(completing);
      assert.equal(f.starts(), 1);
      yield* Deferred.succeed(pairing, undefined);
      assert.equal((yield* Queue.take(f.admissions)).disposition, "leader");
      yield* Fiber.join(first);
      assert.equal((yield* Fiber.join(second)).value, 2);
    }).pipe(Effect.scoped),
  );

  it.effect.each(["failure", "defect", "interruption"] as const)(
    "settles the full %s Exit and evicts the failed slot",
    (kind) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const error = new SshLaunchError({ message: "fixture", stdout: "" });
        const events: DesktopSshPreparationProgress[] = [];
        const exit = yield* Effect.exit(
          f.ensure({
            onProgress: (progress) => events.push(progress),
            prepare: () =>
              kind === "failure"
                ? Effect.fail(error)
                : kind === "defect"
                  ? Effect.die(error)
                  : Effect.interrupt,
          }),
        );
        assert.isTrue(Exit.isFailure(exit));
        assert.equal(events.at(-1)?.outcome, "failed");
        if (Exit.isFailure(exit)) {
          if (kind === "interruption") assert.isTrue(Cause.hasInterrupts(exit.cause));
          else assert.include(Cause.pretty(exit.cause), "fixture");
        }
        yield* Deferred.succeed(f.release, undefined);
        yield* f.ensure();
        assert.equal((yield* Queue.take(f.admissions)).disposition, "leader");
        assert.equal((yield* Queue.take(f.admissions)).disposition, "leader");
      }).pipe(Effect.scoped),
  );

  it.effect("900-second total deadline interrupts work and a late join cannot renew it", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const first = yield* Effect.exit(f.ensure()).pipe(Effect.forkChild);
      const report = yield* Deferred.await(f.entered);
      yield* Queue.take(f.admissions);
      yield* TestClock.adjust("899 seconds");
      report.onPhase("starting");
      const events: DesktopSshPreparationProgress[] = [];
      const second = yield* Effect.exit(
        f.ensure({ onProgress: (event) => events.push(event) }),
      ).pipe(Effect.forkChild);
      assert.equal((yield* Queue.take(f.admissions)).disposition, "join");
      assert.equal(events[0]?.remainingMs, 1_000);
      yield* TestClock.adjust("1 second");
      yield* Deferred.await(f.stopped);
      for (const caller of [first, second]) {
        const exit = yield* Fiber.join(caller);
        assert.isTrue(Exit.isFailure(exit));
        if (Exit.isFailure(exit))
          assert.instanceOf(
            Cause.findErrorOption(exit.cause).pipe((error) =>
              error._tag === "Some" ? error.value : undefined,
            ),
            SshPreparationTimeoutError,
          );
      }
      assert.equal(events.at(-1)?.outcome, "failed");
      assert.equal(f.starts(), 1);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "cancelling the last waiter during failure publication cannot admit a successor early",
    () =>
      Effect.gen(function* () {
        const scope = yield* Scope.Scope;
        const flights = yield* makeEnsureFlights<number, SshLaunchError>({ scope });
        const publishing = yield* Deferred.make<void>();
        const published = yield* Deferred.make<void>();
        const admissions = yield* Queue.unbounded<PreparationAdmission>();
        let starts = 0;
        const input = {
          key: "fixture",
          generation: 0,
          intent: "ordinary",
          terminal: () => ({ outcome: "pending" as const }),
          onAdmission: (admission: PreparationAdmission) => {
            Queue.offerUnsafe(admissions, admission);
          },
          prepare: () =>
            Effect.sync(() => {
              starts++;
            }).pipe(
              Effect.andThen(Effect.fail(new SshLaunchError({ message: "fixture", stdout: "" }))),
            ),
          onFailure: () =>
            Deferred.succeed(publishing, undefined).pipe(Effect.andThen(Deferred.await(published))),
        };
        const first = yield* Effect.scoped(flights.join(input)).pipe(Effect.forkChild);
        yield* Deferred.await(publishing);
        yield* Queue.take(admissions);
        yield* Fiber.interrupt(first);
        const second = yield* Effect.exit(Effect.scoped(flights.join(input))).pipe(
          Effect.forkChild,
        );
        assert.equal((yield* Queue.take(admissions)).disposition, "join");
        assert.equal(starts, 1);
        yield* Deferred.succeed(published, undefined);
        assert.isTrue(Exit.isFailure(yield* Fiber.join(second)));
      }).pipe(Effect.scoped),
  );

  it.effect(
    "retired flight finalizers cannot evict a successor; old generations cannot retire new work",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const first = yield* Effect.exit(f.ensure()).pipe(Effect.forkChild);
        yield* Deferred.await(f.entered);
        yield* Queue.take(f.admissions);
        yield* f.flights.retire(f.input.key);
        const second = yield* f.ensure({ generation: 1 }).pipe(Effect.forkChild);
        assert.equal((yield* Queue.take(f.admissions)).disposition, "leader");
        assert.isTrue(Exit.isFailure(yield* Effect.exit(f.ensure())));
        const third = yield* f.ensure({ generation: 1 }).pipe(Effect.forkChild);
        assert.equal((yield* Queue.take(f.admissions)).disposition, "join");
        yield* Fiber.join(first);
        yield* Deferred.succeed(f.release, undefined);
        yield* Fiber.join(second);
        yield* Fiber.join(third);
        assert.equal(f.starts(), 2);
      }).pipe(Effect.scoped),
  );

  it.effect("manager shutdown settles all waiters and rejects new admissions", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const flights = yield* makeEnsureFlights<number, SshLaunchError>({ scope });
      const entered = yield* Deferred.make<void>();
      const input = {
        key: "fixture",
        generation: 0,
        intent: "ordinary",
        prepare: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
        terminal: () => ({ outcome: "pending" as const }),
      };
      const waiter = yield* Effect.exit(Effect.scoped(flights.join(input))).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* Scope.close(scope, Exit.void);
      assert.isTrue(Exit.isFailure(yield* Fiber.join(waiter)));
      assert.isTrue(Exit.isFailure(yield* Effect.exit(Effect.scoped(flights.join(input)))));
    }),
  );
});
