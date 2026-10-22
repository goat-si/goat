import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { DesktopSshPreparationProgress } from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Queue from "effect/Queue";
import * as References from "effect/References";
import { TestClock } from "effect/testing";
import { SshHostAnswered, SshReconnectCost } from "./command.ts";
import { SshEnsureSupersededError, SshPreparationTimeoutError } from "./errors.ts";
import type { PreparationAdmission } from "./ensureFlight.ts";
import { makeEnsureFlightFixture } from "./tunnel.ensure-flight.fixture.ts";
import { uploadTarget } from "./tunnel.fixture.ts";
import { SshEnvironmentManager } from "./tunnel.ts";

describe("real manager preparation sharing", () => {
  it.effect(
    "two windows join one 258-second acquisition/upload; leader cancellation leaves independent pairing tokens",
    () =>
      Effect.gen(function* () {
        const f = yield* makeEnsureFlightFixture;
        yield* Effect.gen(function* () {
          const manager = yield* SshEnvironmentManager;
          const admissions = yield* Queue.unbounded<PreparationAdmission>();
          const events: DesktopSshPreparationProgress[][] = [[], [], []];
          const answered = [0, 0, 0];
          const ensure = (window: number) =>
            manager
              .ensureEnvironment(uploadTarget, {
                issuePairingToken: true,
                onPreparationProgress: (progress) => events[window]!.push(progress),
                onPreparationAdmission: (admission) => {
                  Queue.offerUnsafe(admissions, admission);
                },
              })
              .pipe(
                Effect.provideService(SshHostAnswered, () => {
                  answered[window]!++;
                }),
              );
          const leader = yield* ensure(0).pipe(Effect.forkChild);
          assert.equal((yield* Queue.take(admissions)).disposition, "leader");
          yield* Deferred.await(f.uploadEntered);
          yield* TestClock.adjust("20 seconds");
          const second = yield* ensure(1).pipe(Effect.forkChild);
          assert.equal((yield* Queue.take(admissions)).disposition, "join");
          yield* Fiber.interrupt(leader);
          const detached = events[0]!.length;
          yield* TestClock.adjust("40 seconds");
          const third = yield* ensure(2).pipe(Effect.forkChild);
          assert.equal((yield* Queue.take(admissions)).disposition, "join");
          assert.equal(events[2]![0]?.remainingMs, 840_000);
          assert.equal(events[2]![0]?.phase, "uploading");
          assert.isTrue(events[2]![0]?.hostAnswered);
          yield* TestClock.adjust("198 seconds");
          assert.equal(f.count.acquisitions, 1);
          assert.equal(f.count.uploads, 1);
          assert.equal(f.count.launches, 0);
          assert.equal(f.count.pairings, 0);
          yield* Deferred.succeed(f.releaseUpload, undefined);
          const result2 = yield* Fiber.join(second);
          const result3 = yield* Fiber.join(third);
          if ("type" in result2 || "type" in result3)
            return yield* Effect.die("Expected ready attachments");
          assert.notEqual(result2.pairingToken, result3.pairingToken);
          assert.equal(result2.attachmentId, result3.attachmentId);
          assert.deepEqual(f.count, {
            acquisitions: 1,
            uploads: 1,
            launches: 1,
            pairings: 2,
            forwards: 1,
            kills: 0,
          });
          assert.equal(events[0]!.length, detached);
          for (const window of [1, 2]) {
            assert.isAtLeast(answered[window]!, 1);
            const terminal = events[window]!.at(-1)!;
            assert.equal(terminal.phase, null);
            assert.equal(terminal.outcome, "ready");
            assert.equal(terminal.runtimeStatus?.state, "ready");
            assert.equal(terminal.attachmentId, result2.attachmentId);
          }
          assert.equal(new Set(events.flat().map((event) => event.operationId)).size, 1);
        }).pipe(Effect.provide(f.layer), Effect.scoped);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect.each([false, true])(
    "published fallback policy changes require a separate preparation: %s",
    (changed) =>
      Effect.gen(function* () {
        const f = yield* makeEnsureFlightFixture;
        yield* Effect.gen(function* () {
          const manager = yield* SshEnvironmentManager;
          const admissions = yield* Queue.unbounded<PreparationAdmission>();
          const observed = yield* Deferred.make<void>();
          const options = {
            onPreparationAdmission: (admission: PreparationAdmission) => {
              Queue.offerUnsafe(admissions, admission);
            },
          };
          const first = yield* manager
            .ensureEnvironment(uploadTarget, options)
            .pipe(Effect.forkChild);
          const original = yield* Queue.take(admissions);
          yield* Deferred.await(f.uploadEntered);
          f.runner.publishedFallback = changed;
          const second = yield* manager
            .ensureEnvironment(uploadTarget, {
              ...options,
              onPreparationProgress: () => {
                Deferred.doneUnsafe(observed, Effect.void);
              },
            })
            .pipe(Effect.forkChild);
          yield* Deferred.await(observed);
          yield* Deferred.succeed(f.releaseUpload, undefined);
          yield* Fiber.join(first);
          yield* Fiber.join(second);
          const next = yield* Queue.take(admissions);
          assert.equal(next.disposition, changed ? "leader" : "join");
          assert.equal(next.operationId === original.operationId, !changed);
          assert.equal(f.count.uploads, 1);
        }).pipe(Effect.provide(f.layer), Effect.scoped);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("a failed per-caller pairing cannot fail the prepared runtime or another caller", () =>
    Effect.gen(function* () {
      const f = yield* makeEnsureFlightFixture;
      f.state.holdUpload = false;
      f.state.pairingFails = true;
      yield* Effect.gen(function* () {
        const manager = yield* SshEnvironmentManager;
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(
              manager.ensureEnvironment(uploadTarget, { issuePairingToken: true }),
            ),
          ),
        );
        const ready = yield* manager.readyEnvironment(uploadTarget);
        assert.equal(ready.remoteServerVersion, "1.2.3-preview.20260911.4");
        f.state.pairingFails = false;
        const next = yield* manager.ensureEnvironment(uploadTarget, { issuePairingToken: true });
        assert.notProperty(next, "type");
        assert.equal(f.count.uploads, 1);
        assert.equal(f.count.launches, 1);
        assert.equal(f.count.pairings, 2);
      }).pipe(Effect.provide(f.layer), Effect.scoped);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect.each(["disconnect", "forget"] as const)(
    "%s during installation fences publication and settles the caller neutrally",
    (action) =>
      Effect.gen(function* () {
        const f = yield* makeEnsureFlightFixture;
        yield* Effect.gen(function* () {
          const manager = yield* SshEnvironmentManager;
          const terminal = yield* Deferred.make<DesktopSshPreparationProgress>();
          const caller = yield* Effect.exit(
            manager.ensureEnvironment(uploadTarget, {
              onPreparationProgress: (progress) => {
                if (progress.phase === null) Deferred.doneUnsafe(terminal, Exit.succeed(progress));
              },
            }),
          ).pipe(Effect.forkChild);
          yield* Deferred.await(f.uploadEntered);
          const invalidation = yield* (
            action === "disconnect"
              ? manager.disconnectEnvironment(uploadTarget)
              : manager.forgetEnvironment(uploadTarget, { stopRuntime: "no" })
          ).pipe(Effect.forkChild);
          assert.equal((yield* Deferred.await(terminal)).outcome, "superseded");
          const exit = yield* Fiber.join(caller);
          assert.isTrue(Exit.isFailure(exit));
          if (Exit.isFailure(exit))
            assert.include(Cause.pretty(exit.cause), "SshEnsureSupersededError");
          yield* Deferred.succeed(f.releaseUpload, undefined);
          yield* Fiber.join(invalidation);
          assert.equal(f.count.forwards, 0);
          assert.isTrue(Exit.isFailure(yield* Effect.exit(manager.readyEnvironment(uploadTarget))));
        }).pipe(Effect.provide(f.layer), Effect.scoped);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect(
    "native deadline interrupts the actual upload at 900 seconds and clears active progress",
    () =>
      Effect.gen(function* () {
        const f = yield* makeEnsureFlightFixture;
        yield* Effect.gen(function* () {
          const manager = yield* SshEnvironmentManager;
          const events: DesktopSshPreparationProgress[] = [];
          const caller = yield* Effect.exit(
            manager.ensureEnvironment(uploadTarget, {
              onPreparationProgress: (progress) => events.push(progress),
            }),
          ).pipe(Effect.forkChild);
          yield* Deferred.await(f.uploadEntered);
          yield* TestClock.adjust("15 minutes");
          const exit = yield* Fiber.join(caller);
          assert.isTrue(Exit.isFailure(exit));
          if (Exit.isFailure(exit)) {
            const error = Cause.findErrorOption(exit.cause);
            assert.instanceOf(
              error._tag === "Some" ? error.value : undefined,
              SshPreparationTimeoutError,
            );
          }
          assert.equal(events.at(-1)?.outcome, "failed");
          assert.equal(events.at(-1)?.remainingMs, 0);
          assert.equal(f.count.launches, 0);
          assert.isTrue(Exit.isFailure(yield* Effect.exit(manager.readyEnvironment(uploadTarget))));
        }).pipe(Effect.provide(f.layer), Effect.scoped);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect(
    "disconnect while pairing prevents a stale credential result without changing shared worker ownership",
    () =>
      Effect.gen(function* () {
        const f = yield* makeEnsureFlightFixture;
        f.state.holdUpload = false;
        f.state.holdPairing = true;
        yield* Effect.gen(function* () {
          const manager = yield* SshEnvironmentManager;
          const superseded = yield* Deferred.make<void>();
          const caller = yield* Effect.exit(
            manager.ensureEnvironment(uploadTarget, {
              issuePairingToken: true,
              onPreparationProgress: (progress) => {
                if (progress.outcome === "superseded") Deferred.doneUnsafe(superseded, Exit.void);
              },
            }),
          ).pipe(Effect.forkChild);
          yield* Deferred.await(f.pairingEntered);
          const fence = yield* Deferred.make<void>();
          // Generation changes before disconnect waits for pairing's target lock.
          const disconnect = yield* manager.disconnectEnvironment(uploadTarget).pipe(
            Effect.onExit(() => Deferred.succeed(fence, undefined)),
            Effect.forkChild,
          );
          yield* Deferred.await(superseded);
          yield* Deferred.succeed(f.releasePairing, undefined);
          const exit = yield* Fiber.join(caller);
          assert.isTrue(Exit.isFailure(exit));
          if (Exit.isFailure(exit)) {
            const error = Cause.findErrorOption(exit.cause);
            assert.instanceOf(
              error._tag === "Some" ? error.value : undefined,
              SshEnsureSupersededError,
            );
          }
          yield* Fiber.join(disconnect);
          yield* Deferred.await(fence);
          assert.equal(f.count.pairings, 1);
          assert.equal(f.count.kills, 1);
        }).pipe(Effect.provide(f.layer), Effect.scoped);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect(
    "worker owns one operation-correlated cost after the initiating request's cost closes",
    () =>
      Effect.gen(function* () {
        const f = yield* makeEnsureFlightFixture;
        const records: Readonly<Record<string, unknown>>[] = [];
        const logger = Logger.make(({ fiber, message }) => {
          if (String(message) === "ssh.reconnect.cost")
            records.push(fiber.getRef(References.CurrentLogAnnotations));
        });
        yield* Effect.gen(function* () {
          const manager = yield* SshEnvironmentManager;
          const admissions = yield* Queue.unbounded<PreparationAdmission>();
          const cost = { active: true, spawns: 0, authentications: 0, steps: {} };
          const first = yield* manager
            .ensureEnvironment(uploadTarget, {
              onPreparationAdmission: (admission) => {
                Queue.offerUnsafe(admissions, admission);
              },
            })
            .pipe(Effect.provideService(SshReconnectCost, cost), Effect.forkChild);
          const admission = yield* Queue.take(admissions);
          yield* Deferred.await(f.uploadEntered);
          yield* Fiber.interrupt(first);
          cost.active = false;
          const snapshot = { ...cost, steps: { ...cost.steps } };
          const joined = yield* manager
            .ensureEnvironment(uploadTarget, {
              onPreparationAdmission: (value) => {
                Queue.offerUnsafe(admissions, value);
              },
            })
            .pipe(Effect.forkChild);
          assert.equal((yield* Queue.take(admissions)).disposition, "join");
          yield* TestClock.adjust("258 seconds");
          yield* Deferred.succeed(f.releaseUpload, undefined);
          yield* Fiber.join(joined);
          assert.deepEqual(cost, snapshot);
          assert.lengthOf(records, 1);
          assert.equal(records[0]?.operationId, admission.operationId);
          assert.isAtLeast(Number(records[0]?.wallMs), 258_000);
          assert.isAtLeast(Number(records[0]?.spawns), 3);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(f.layer, Logger.layer([logger], { mergeWithExisting: false })),
          ),
          Effect.provideService(References.MinimumLogLevel, "Info"),
          Effect.scoped,
        );
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
