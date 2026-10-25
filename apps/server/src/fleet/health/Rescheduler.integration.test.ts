import { describe, expect, it } from "@effect/vitest";
import {
  BUILTIN_PERMISSION_PROFILES,
  FleetOwnerKey,
  type HostStatusEntry,
  type RuntimeMode,
  ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as HostPowerMonitor from "../../background/HostPowerMonitor.ts";
import * as FleetHostStates from "./FleetHostStates.ts";
import * as Health from "./Health.ts";
import * as HostHealthMonitor from "./HostHealthMonitor.ts";
import * as Rescheduler from "./Rescheduler.ts";

import {
  newWorld,
  withServer,
  databaseFile,
  ref,
  request,
  observe,
  loseA,
  testScoped,
} from "./Rescheduler.testkit.ts";

describe("Rescheduler", () => {
  it.effect(
    "resumes work from a Lost host on another host exactly once, across a lost answer and a restart",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const world = newWorld();
          const filename = yield* databaseFile;
          yield* withServer(
            world,
            filename,
            Effect.gen(function* () {
              const rescheduler = yield* Rescheduler.Rescheduler;
              // The fake answers with real payloads, so a running attempt reads healthy.
              expect(yield* observe(0)).toEqual({ _tag: "healthy", idle: false });
              world.reachable.A = false;
              expect((yield* observe(3))._tag).toBe("unknown");
              expect(yield* rescheduler.reschedule(request())).toMatchObject({
                reason: "host_still_answers",
              });
              expect((yield* observe(5))._tag).toBe("host_lost");
              world.loseNextLaunchResponse = true;
              expect(yield* rescheduler.reschedule(request())).toMatchObject({
                _tag: "Refused",
                reason: "no_capacity",
              });
              expect(world.launches).toHaveLength(1);
            }),
          );
          // After a restart the claim points at B, and the retry adopts the thread found there.
          yield* withServer(
            world,
            filename,
            Effect.gen(function* () {
              const rescheduler = yield* Rescheduler.Rescheduler;
              const first = yield* rescheduler.reschedule(request());
              const again = yield* rescheduler.reschedule(request());
              expect(first).toEqual({
                _tag: "Rescheduled",
                host: "B",
                threadId: "thread:B1",
                branch: "goal-g1-s0-a2",
                resumedFrom: "branch",
              });
              expect(again).toEqual(first);
              expect(world.launches).toHaveLength(1);
            }),
          );
          const launch = world.launches[0]!;
          expect(launch).toMatchObject({
            host: "B",
            cwd: "/repo",
            title: Rescheduler.attemptTitle("goal:g1", "goal:g1:s0:a2:launch", "goal-g1-s0-a2"),
            runtimeMode: "full-access",
            workspace: {
              type: "worktree",
              branch: "goal-g1-s0-a2",
              baseRef: "goal-g1-s0-a1",
              startFromOrigin: true,
            },
          });
          expect(launch.message).toContain("Ship the thing.");
          expect(launch.message).toContain("GOAT moved this work from thread thread:a1 on A");
        }),
      ),
  );

  testScoped("never launches elsewhere while an earlier launch's host cannot be checked", (world) =>
    Effect.gen(function* () {
      const rescheduler = yield* Rescheduler.Rescheduler;
      world.reachable.C = true;
      yield* loseA(world);
      world.loseNextLaunchResponse = true;
      const first = yield* rescheduler.reschedule(request({ targetHost: "B" }));
      expect(first).toMatchObject({ reason: "no_capacity" });
      // B now fails its thread list: the outcome there is unknown, so C gets nothing.
      world.failing.add("B/goat_thread_list");
      expect(yield* rescheduler.reschedule(request())).toMatchObject({ reason: "no_capacity" });
      expect(world.launches.map((launch) => launch.host)).toEqual(["B"]);
      world.failing.delete("B/goat_thread_list");
      expect(yield* rescheduler.reschedule(request())).toMatchObject({
        _tag: "Rescheduled",
        host: "B",
        threadId: "thread:B1",
      });
      expect(world.launches).toHaveLength(1);
    }),
  );

  testScoped(
    "regression #1451: a held move whose answer was lost stays unconfirmed until findMove sees its thread",
    (world) =>
      Effect.gen(function* () {
        const rescheduler = yield* Rescheduler.Rescheduler;
        const held = request({
          holdUnconfirmed: true,
          callerRuntimeMode: "full-access",
          runtimeMode: "auto",
        });
        yield* loseA(world);
        // Nothing was claimed yet, so nothing can have launched.
        expect(
          yield* rescheduler.findMove({ clientRequestId: held.clientRequestId, owner: held.owner }),
        ).toEqual({ _tag: "NotLaunched" });
        world.loseNextLaunchResponse = true;
        expect(yield* rescheduler.reschedule(held)).toMatchObject({
          _tag: "Unconfirmed",
          host: "B",
        });
        expect(world.launches[0]).toMatchObject({
          runtimeMode: "auto",
          callerRuntimeMode: "full-access",
        });
        // B cannot be listed: unknown, and a retry launches nothing anywhere.
        world.failing.add("B/goat_thread_list");
        expect(
          yield* rescheduler.findMove({ clientRequestId: held.clientRequestId, owner: held.owner }),
        ).toMatchObject({ _tag: "Unknown", host: "B" });
        expect(yield* rescheduler.reschedule(held)).toMatchObject({
          _tag: "Unconfirmed",
          host: "B",
        });
        // Another owner's lookup never adopts it.
        expect(
          yield* rescheduler.findMove({
            clientRequestId: held.clientRequestId,
            owner: FleetOwnerKey.make("goal:other"),
          }),
        ).toMatchObject({ _tag: "Unknown" });
        world.failing.delete("B/goat_thread_list");
        expect(
          yield* rescheduler.findMove({ clientRequestId: held.clientRequestId, owner: held.owner }),
        ).toEqual({ _tag: "Launched", host: "B", threadId: "thread:B1", branch: "goal-g1-s0-a2" });
        expect(yield* rescheduler.reschedule(held)).toMatchObject({
          _tag: "Rescheduled",
          host: "B",
        });
        expect(world.launches).toHaveLength(1);
      }),
  );

  testScoped(
    "regression #1451: a held move never relaunches when its earlier launch is not listed",
    (world) =>
      Effect.gen(function* () {
        const rescheduler = yield* Rescheduler.Rescheduler;
        const held = request({ holdUnconfirmed: true });
        yield* loseA(world);
        world.loseNextLaunchResponse = true;
        expect(yield* rescheduler.reschedule(held)).toMatchObject({ _tag: "Unconfirmed" });
        // The launch has not appeared there (yet): a person's retry would relaunch on B; a held one waits.
        world.threads.splice(
          world.threads.findIndex((thread) => thread.host === "B"),
          1,
        );
        expect(yield* rescheduler.reschedule(held)).toMatchObject({
          _tag: "Unconfirmed",
          host: "B",
        });
        expect(
          yield* rescheduler.findMove({ clientRequestId: held.clientRequestId, owner: held.owner }),
        ).toMatchObject({ _tag: "Unknown" });
        expect(world.launches).toHaveLength(1);
      }),
  );

  testScoped("regression #1451: a move never lands on a host the goal excludes", (world) =>
    Effect.gen(function* () {
      const rescheduler = yield* Rescheduler.Rescheduler;
      world.reachable.C = true;
      yield* loseA(world);
      expect(yield* rescheduler.reschedule(request({ excludeHosts: ["B"] }))).toMatchObject({
        _tag: "Rescheduled",
        host: "C",
      });
    }),
  );

  testScoped("never adopts another owner's thread on the same branch name", (world) =>
    Effect.gen(function* () {
      const rescheduler = yield* Rescheduler.Rescheduler;
      world.threads.push({
        host: "B",
        threadId: ThreadId.make("thread:other"),
        title: Rescheduler.attemptTitle("goal:other", "goal:g1:s0:a2:launch", "goal-g1-s0-a2"),
        phase: "running",
      });
      yield* loseA(world);
      const moved = yield* rescheduler.reschedule(request());
      expect(moved).toMatchObject({ _tag: "Rescheduled", host: "B", threadId: "thread:B1" });
      expect(world.launches).toHaveLength(1);
    }),
  );

  testScoped("lets placement choose only among the caller's allowed hosts", (world) =>
    Effect.gen(function* () {
      const rescheduler = yield* Rescheduler.Rescheduler;
      world.reachable.C = true;
      yield* loseA(world);
      // B and C are equally free, and B comes first; a profile limited to C must not land on B.
      const refused = yield* rescheduler.reschedule(request({ allowedHosts: ["A"] }));
      expect(refused).toMatchObject({
        _tag: "Refused",
        reason: "no_capacity",
        message: expect.stringContaining("goatclaw profile allows (A)"),
      });
      expect(world.launches).toEqual([]);
      const moved = yield* rescheduler.reschedule(request({ allowedHosts: ["C"] }));
      expect(moved).toMatchObject({ _tag: "Rescheduled", host: "C" });
      expect(world.launches.map((launch) => launch.host)).toEqual(["C"]);
    }),
  );

  testScoped("keeps an earlier attempt's host to the caller's allowed hosts", (world) =>
    Effect.gen(function* () {
      const rescheduler = yield* Rescheduler.Rescheduler;
      world.reachable.C = true;
      yield* loseA(world);
      // An earlier caller's launch on B ended without an answer; B now shows no such thread.
      yield* (yield* FleetHostStates.FleetRescheduleClaims).claim({
        clientRequestId: "goal:g1:s0:a2:launch",
        ownerKey: FleetOwnerKey.make("goal:g1"),
        targetHost: "B",
        title: Rescheduler.attemptTitle("goal:g1", "goal:g1:s0:a2:launch", "goal-g1-s0-a2"),
        branch: "goal-g1-s0-a2",
      });
      const refused = yield* rescheduler.reschedule(request({ allowedHosts: ["C"] }));
      expect(refused).toMatchObject({ _tag: "Refused", reason: "not_allowed" });
      expect(world.launches).toEqual([]);
    }),
  );

  testScoped(
    "asks a host remembered as Lost again before moving, and interrupts it when it answers",
    (world) =>
      Effect.gen(function* () {
        const rescheduler = yield* Rescheduler.Rescheduler;
        yield* loseA(world);
        world.reachable.A = true;
        expect(
          yield* rescheduler.reschedule(request({ reason: "stalled", force: true })),
        ).toMatchObject({
          reason: "host_still_answers",
        });
        expect(world.launches).toHaveLength(0);
        expect(world.threads[0]!.phase).toBe("interrupted");
        // Confirmed stopped: now it moves.
        expect(yield* rescheduler.reschedule(request({ reason: "stalled" }))).toMatchObject({
          _tag: "Rescheduled",
        });
      }),
  );

  testScoped("stops when the caller loses its authority while the move waits", (world) =>
    Effect.gen(function* () {
      const rescheduler = yield* Rescheduler.Rescheduler;
      yield* loseA(world);
      let mode: RuntimeMode = "full-access";
      const authorize = Effect.sync(() => mode);
      mode = "approval-required";
      expect(yield* rescheduler.reschedule(request({ authorize }))).toMatchObject({
        reason: "not_allowed",
      });
      const gone = Effect.fail(
        new Rescheduler.RescheduleNotAllowed({ message: "The launcher thread was archived." }),
      );
      expect(yield* rescheduler.reschedule(request({ authorize: gone }))).toEqual({
        _tag: "Refused",
        reason: "not_allowed",
        message: "The launcher thread was archived.",
      });
      expect(world.launches).toHaveLength(0);
      expect(world.calls.filter((call) => call.tool === "goat_thread_interrupt")).toHaveLength(0);
    }),
  );

  testScoped(
    "regression #1451: the attempt cap follows the goal's maxAttemptsPerWorker; manual moves keep 3",
    (world) =>
      Effect.gen(function* () {
        const rescheduler = yield* Rescheduler.Rescheduler;
        yield* loseA(world);
        const at = (attempt: number, maxAttempts?: number) =>
          rescheduler.reschedule(
            request({
              attempt,
              ...(maxAttempts === undefined ? {} : { maxAttempts }),
              clientRequestId: "goal:g1:s0:a" + (attempt + 1) + ":launch:" + maxAttempts,
              workspace: {
                baseRef: "dev",
                branch: "goal-g1-s0-a" + (attempt + 1) + "-" + maxAttempts,
                startFromOrigin: true,
              },
            }),
          );
        const outcomes = [
          yield* at(1, 1),
          yield* at(2),
          yield* at(3),
          yield* at(9, 10),
          yield* at(10, 10),
        ].map((result) => (result._tag === "Refused" ? result.reason : result._tag));
        // The last legal successor moves; the one after it is refused.
        expect(outcomes).toEqual(["budget", "Rescheduled", "budget", "Rescheduled", "budget"]);
      }),
  );

  testScoped("regression #969: binds the caller's goatclaw ceiling on the destination", (world) =>
    Effect.gen(function* () {
      const rescheduler = yield* Rescheduler.Rescheduler;
      yield* loseA(world);
      const ceiling = BUILTIN_PERMISSION_PROFILES.worker!;
      const synced: Array<string> = [];
      const moved = yield* rescheduler.reschedule(
        request({
          permissionProfileCeiling: ceiling,
          prepareCeiling: (host) =>
            Effect.sync(() => {
              // The destination's policy is synced before anything launches there.
              expect(world.launches).toHaveLength(0);
              synced.push(host);
            }),
        }),
      );
      expect(moved).toMatchObject({ _tag: "Rescheduled", host: "B" });
      expect(synced).toEqual(["B"]);
      expect(world.launches.map((launch) => launch.permissionProfileCeiling)).toEqual([ceiling]);
    }),
  );

  testScoped(
    "regression #969: refuses a destination that cannot hold the ceiling, then places again",
    (world) =>
      Effect.gen(function* () {
        const rescheduler = yield* Rescheduler.Rescheduler;
        yield* loseA(world);
        world.noCeilingHosts.add("B");
        const bounded = request({ permissionProfileCeiling: BUILTIN_PERMISSION_PROFILES.worker! });
        expect(yield* rescheduler.reschedule(bounded)).toMatchObject({
          _tag: "Refused",
          reason: "unsupported_remote",
          message: expect.stringContaining("permission_profile_unsupported"),
        });
        expect(world.launches).toEqual([]);
        // Nothing launched, so the request is free to place once the destination updates.
        world.noCeilingHosts.delete("B");
        expect(yield* rescheduler.reschedule(bounded)).toMatchObject({
          _tag: "Rescheduled",
          host: "B",
        });
      }),
  );

  testScoped("drains between runs and never interrupts a running turn", (world) =>
    Effect.gen(function* () {
      const rescheduler = yield* Rescheduler.Rescheduler;
      expect(yield* rescheduler.reschedule(request({ reason: "drain" }))).toMatchObject({
        reason: "host_still_answers",
      });
      expect(world.calls.filter((call) => call.tool === "goat_thread_interrupt")).toHaveLength(0);
      world.threads[0]!.phase = "completed";
      expect(yield* rescheduler.reschedule(request({ reason: "drain" }))).toMatchObject({
        _tag: "Rescheduled",
        host: "B",
      });
    }),
  );

  testScoped("reads an older host's thread through goat_thread_read", (world) =>
    Effect.gen(function* () {
      const rescheduler = yield* Rescheduler.Rescheduler;
      world.oldHosts.add("A");
      world.threads[0]!.phase = "completed";
      expect(yield* observe(0)).toEqual({ _tag: "healthy", idle: true });
      expect(yield* rescheduler.reschedule(request({ reason: "manual" }))).toMatchObject({
        _tag: "Rescheduled",
      });
      expect(
        world.calls.some((call) => call.host === "A" && call.tool === "goat_thread_read"),
      ).toBe(true);
    }),
  );

  testScoped("treats an unknown host alias as no answer, never as Ready", (world) =>
    Effect.gen(function* () {
      const rescheduler = yield* Rescheduler.Rescheduler;
      const monitor = yield* HostHealthMonitor.HostHealthMonitor;
      const nowhere = { host: "nowhere", threadId: ThreadId.make("thread:x"), watchId: null };
      expect(
        yield* rescheduler.reschedule(request({ ref: nowhere, reason: "manual" })),
      ).toMatchObject({
        reason: "host_still_answers",
      });
      expect(
        (yield* monitor.conditions("nowhere")).conditions.map((condition) => condition.type),
      ).not.toContain("Ready");
      expect(world.launches).toHaveLength(0);
    }),
  );

  testScoped("respects cordons when placing", (world) =>
    Effect.gen(function* () {
      const rescheduler = yield* Rescheduler.Rescheduler;
      const states = yield* FleetHostStates.FleetHostStates;
      world.threads[0]!.phase = "completed";
      yield* states.cordon({
        host: "B",
        draining: false,
        reason: "maintenance",
        changedBy: "test",
      });
      expect(yield* rescheduler.reschedule(request({ reason: "manual" }))).toMatchObject({
        reason: "no_capacity",
      });
      yield* states.uncordon("B");
      expect(yield* rescheduler.reschedule(request({ reason: "manual" }))).toMatchObject({
        _tag: "Rescheduled",
        host: "B",
      });
    }),
  );

  testScoped("reports this machine's own quota limits", () =>
    Effect.gen(function* () {
      const monitor = yield* HostHealthMonitor.HostHealthMonitor;
      const local = {
        host: null,
        reachability: "ok",
        metrics: {
          quotas: [
            {
              instanceId: "codex",
              driver: "codex",
              fromCache: false,
              limits: {
                checkedAt: "2026-10-20T00:00:00.000Z",
                windows: [
                  {
                    id: "primary",
                    kind: "weekly",
                    label: "Weekly",
                    usedPercent: 100,
                    resetsAt: "2099-01-01T00:00:00.000Z",
                  },
                ],
              },
            },
          ],
        },
      } as unknown as HostStatusEntry;
      const annotated = yield* monitor.annotate({ hosts: [local] });
      expect(annotated.hosts[0]!.conditions?.map((condition) => condition.type)).toEqual([
        "Ready",
        "QuotaExhausted",
      ]);
    }),
  );

  it.effect("does not count a host as Lost when this machine wakes from an hour of sleep", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const world = newWorld();
        const filename = yield* databaseFile;
        yield* withServer(
          world,
          filename,
          Effect.gen(function* () {
            const monitor = yield* HostHealthMonitor.HostHealthMonitor;
            const rescheduler = yield* Rescheduler.Rescheduler;
            yield* monitor.tick;
            world.reachable.A = false;
            yield* observe(2);
            yield* TestClock.adjust(Duration.minutes(60));
            // The first call after waking can beat the clock source; it must still see the wake.
            expect((yield* (yield* Health.Health).threadHealth(ref))._tag).toBe("unknown");
            for (let minute = 0; minute < 4; minute += 1) {
              yield* TestClock.adjust(Duration.minutes(1));
              expect((yield* (yield* Health.Health).threadHealth(ref))._tag).toBe("unknown");
            }
            expect(yield* rescheduler.reschedule(request())).toMatchObject({
              reason: "host_still_answers",
            });
            world.reachable.A = true;
            expect((yield* observe(1))._tag).toBe("healthy");
            expect(world.launches).toHaveLength(0);
          }),
        );
      }),
    ),
  );

  it.effect(
    "drops failures when the power monitor reports a suspend shorter than the tick gap",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const world = newWorld();
          const filename = yield* databaseFile;
          const power = yield* HostPowerMonitor.make();
          const powerLayer = Layer.succeed(HostPowerMonitor.HostPowerMonitor, power);
          yield* withServer(
            world,
            filename,
            Effect.gen(function* () {
              const health = yield* Health.Health;
              world.reachable.A = false;
              // Three failures 30 s apart: Unreachable, with no tick gap long enough to look like sleep.
              for (let step = 0; step < 3; step += 1) {
                yield* TestClock.adjust(Duration.seconds(30));
                yield* health.threadHealth(ref);
              }
              expect(
                (yield* health.hostCondition("A")).conditions.map((condition) => condition.type),
              ).toContain("Unreachable");
              const snapshot = yield* power.snapshot;
              const at = yield* DateTime.now;
              // The power PubSub keeps only the newest change, so let the consumer see each one.
              const settle = Effect.forEach([1, 2, 3, 4], () => Effect.yieldNow, { discard: true });
              yield* power.report({ ...snapshot, suspended: true, stale: false, updatedAt: at });
              yield* settle;
              yield* power.report({ ...snapshot, suspended: false, stale: false, updatedAt: at });
              yield* settle;
              expect(
                (yield* health.hostCondition("A")).conditions.map((condition) => condition.type),
              ).not.toContain("Unreachable");
            }),
            powerLayer,
          );
        }),
      ),
  );

  testScoped(
    "regression #1451: interrupts the attempt under its source authority, not the replacement's lower mode",
    (world) =>
      Effect.gen(function* () {
        const rescheduler = yield* Rescheduler.Rescheduler;
        let sourceChecks = 0;
        const moved = request({
          reason: "stalled",
          runtimeMode: "approval-required",
          callerRuntimeMode: "full-access",
          authorizeSource: Effect.sync(() => {
            sourceChecks += 1;
            return "full-access" as const;
          }),
        });
        expect(yield* rescheduler.reschedule(moved)).toMatchObject({
          reason: "host_still_answers",
          stopping: true,
        });
        const interrupts = world.calls.filter((call) => call.tool === "goat_thread_interrupt");
        expect(interrupts.map((call) => [call.host, call.ceiling])).toEqual([["A", "full-access"]]);
        expect(sourceChecks).toBeGreaterThan(0);
        // A source the caller may no longer reach is not interrupted.
        const denied = request({
          reason: "stalled",
          clientRequestId: "goal:g1:s0:a2:launch:denied",
          authorizeSource: Effect.fail(
            new Rescheduler.RescheduleNotAllowed({ message: "The profile no longer allows A." }),
          ),
        });
        world.threads[0]!.phase = "running";
        expect(yield* rescheduler.reschedule(denied)).toMatchObject({ reason: "not_allowed" });
        expect(world.calls.filter((call) => call.tool === "goat_thread_interrupt")).toHaveLength(1);
      }),
  );

  testScoped(
    "stops a superseded attempt once when its host returns, and fails on a refusal",
    (world) =>
      Effect.gen(function* () {
        const fence = Rescheduler.fenceStaleAttempt({
          ref,
          successorHost: "B",
          successorBranch: "goal-g1-s0-a2",
          clientRequestId: "goal:g1:s0:a1:interrupt",
          authorize: Effect.succeed<RuntimeMode>("full-access"),
        });
        world.reachable.A = false;
        expect((yield* Effect.result(fence))._tag).toBe("Failure");
        world.reachable.A = true;
        yield* fence;
        yield* fence;
        const interrupts = world.calls.filter(
          (call) => call.host === "A" && call.tool === "goat_thread_interrupt",
        );
        expect(new Set(interrupts.map((call) => call.args.clientRequestId))).toEqual(
          new Set(["goal:g1:s0:a1:interrupt"]),
        );
        expect(String(interrupts[1]!.args.reason)).toContain(
          "continues on B on branch goal-g1-s0-a2",
        );
        expect(world.appliedInterrupts.size).toBe(1);
        expect(
          world.calls.some((call) => call.host === "A" && call.tool === "goat_thread_send"),
        ).toBe(false);
      }),
  );
});
