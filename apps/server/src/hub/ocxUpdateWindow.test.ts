import { expect, it } from "@effect/vitest";
import { EnvironmentId } from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as TestClock from "effect/testing/TestClock";
import * as Stream from "effect/Stream";

import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { OpenCodexSync } from "./OpenCodexSync.ts";
import { OpenCodexUpdateHost, type OpenCodexRelease } from "./OpenCodexUpdateHost.ts";
import {
  applyOrchestratedStep,
  recoverUncertain,
  restoreAdmission,
  type AdmissionOwnership,
  type State,
} from "./ocxUpdateWindow.ts";
import { fleetSnapshot } from "./parity.testkit.ts";

const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("window-test"),
  requestNamespace: "window-test",
  thread: undefined,
  client: { sessionId: "window-test", label: "test", access: "read-only" },
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
};
const plan = {
  currentVersion: "2.89.0",
  targetVersion: "2.90.0",
  canApply: true,
  planToken: "abcdefghijklmnop",
  updateInFlight: false,
  mutationBoundMs: 900_000,
  servingPath: null,
  cliPath: "/bin/ocx",
};

const fixture = Effect.fn("OpenCodexWindowTest.fixture")(function* (blockSettlement = true) {
  const boundary = yield* Deferred.make<void>();
  const resume = yield* Deferred.make<void>();
  const retainedHome = yield* Ref.make<AdmissionOwnership>("retained");
  const nextAt = yield* Ref.make(0);
  const holds = yield* Ref.make(1);
  const rollbacks = yield* Ref.make(0);
  const installs = yield* Ref.make(0);
  const state = yield* Ref.make<State>({
    members: [],
    failedTargets: {},
    window: {
      targetVersion: "2.90.0",
      children: [],
      steps: [
        { alias: null, fromVersion: "2.89.0", via: "ocx-update", started: true, restored: true },
      ],
      baseline: {},
      roles: { "": "standalone" },
      startedAt: {},
      processIds: {},
      orchestrated: {
        "": {
          fromVersion: "2.89.0",
          planToken: plan.planToken,
          notAfter: 0,
          boundMs: 1,
          pending: true,
          observed: { version: "2.89.0", processId: 100, startedAt: 1, at: 1 },
        },
      },
    },
  });
  const host = OpenCodexUpdateHost.of({
    latestRelease: Effect.sync((): OpenCodexRelease | undefined => undefined),
    member: (alias) =>
      Effect.succeed({
        alias,
        runningTurns: 0,
        snapshot: {
          ...fleetSnapshot("home"),
          runtime: { ...fleetSnapshot("home").runtime, version: "2.89.0" },
          parityEvidence: {
            ...fleetSnapshot("home").parityEvidence,
            processId: 100,
            startedAt: 1,
            observedAt: 0,
          },
        },
      }),
    orchestratedPlan: () => Effect.succeed({ kind: "plan", plan }),
    applyOrchestrated: () => Effect.succeed("applied"),
    install: () => Ref.update(installs, (value) => value + 1).pipe(Effect.as(false)),
    holdAdmission: () => Ref.update(holds, (n) => n + 1).pipe(Effect.as(true)),
    releaseAdmission: () => Ref.update(holds, (n) => n - 1),
  });
  const mutate = Effect.fn("OpenCodexWindowTest.mutate")(function* (
    change: (current: State, at: number) => State,
  ) {
    const next = change(yield* Ref.get(state), yield* Clock.currentTimeMillis);
    yield* Ref.set(state, next);
    if (blockSettlement && next.window?.orchestrated?.[""]?.settled) {
      yield* Deferred.succeed(boundary, undefined);
      yield* Deferred.await(resume);
    }
  });
  const stateLock = yield* Semaphore.make(1);
  const overrunSignal = yield* Ref.make(yield* Deferred.make<void>());
  const mutateIfCurrent = (
    expected: State,
    change: (current: State, at: number) => State,
    after: Effect.Effect<void> = Effect.void,
  ) =>
    stateLock.withPermit(
      Effect.gen(function* () {
        if ((yield* Ref.get(state)) !== expected) return false;
        yield* mutate(change);
        yield* after;
        return true;
      }).pipe(Effect.uninterruptible),
    );
  const sync = OpenCodexSync.of({
    plan: () => Effect.die("unused"),
    run: () => Effect.die("unused"),
    latest: Effect.sync(() => undefined),
    lastUpdate: Effect.sync(() => undefined),
    changes: Stream.empty,
    markUpdating: () => Effect.void,
    exclusive: (body) => body,
    beginUpdate: () => Effect.void,
    syncUpdatedMember: () => Effect.void,
  });
  const ops = {
    host,
    sync,
    state,
    stateLock,
    overrunSignal,
    mutateIfCurrent,
    enforceOverrun: () => Effect.void,
    retainedHome,
    nextAt,
    mutate,
    record: () => Effect.void,
    rollBack: () => Ref.update(rollbacks, (value) => value + 1).pipe(Effect.as(true)),
    healthProof: () => Effect.succeed({ startedAt: 1, processId: 100 }),
  };
  return { state, holds, rollbacks, installs, ops, boundary, resume };
});

it.effect("releases admission when conclusive apply is interrupted during settlement", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const running = yield* Effect.forkChild(
      applyOrchestratedStep(f.ops, { alias: null, fromVersion: "2.89.0" }, "2.90.0", scope, plan),
    );
    yield* Deferred.await(f.boundary);
    running.interruptUnsafe();
    yield* Deferred.succeed(f.resume, undefined);
    yield* Fiber.await(running);
    yield* restoreAdmission(yield* Ref.get(f.state), f.ops.host, f.ops.retainedHome);
    expect(yield* Ref.get(f.holds)).toBe(0);
  }),
);

it.effect("releases admission when fenced recovery is interrupted during settlement", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* TestClock.setTime(1_000_000);
    const running = yield* Effect.forkChild(
      recoverUncertain(f.ops, yield* Ref.get(f.state), 1_000_000, scope),
    );
    yield* Deferred.await(f.boundary);
    running.interruptUnsafe();
    yield* Deferred.succeed(f.resume, undefined);
    yield* Fiber.await(running);
    yield* restoreAdmission(yield* Ref.get(f.state), f.ops.host, f.ops.retainedHome);
    expect(yield* Ref.get(f.holds)).toBe(0);
  }),
);

it.effect("reconciles a stale retained admission exactly once from durable state", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const current = yield* Ref.get(f.state);
    yield* restoreAdmission(
      { members: current.members, failedTargets: current.failedTargets },
      f.ops.host,
      f.ops.retainedHome,
    );
    yield* restoreAdmission(
      { members: current.members, failedTargets: current.failedTargets },
      f.ops.host,
      f.ops.retainedHome,
    );
    expect(yield* Ref.get(f.holds)).toBe(0);
    yield* TestClock.setTime(1);
    yield* restoreAdmission(current, f.ops.host, f.ops.retainedHome);
    yield* restoreAdmission(current, f.ops.host, f.ops.retainedHome);
    expect(yield* Ref.get(f.holds)).toBe(1);
  }),
);

it.effect("retries forward recovery after interruption before the decision is persisted", () =>
  Effect.gen(function* () {
    const f = yield* fixture(false);
    yield* TestClock.setTime(1_000_000);
    const reached = yield* Deferred.make<void>();
    const stop = yield* Deferred.make<void>();
    yield* Ref.update(f.state, (current) =>
      current.window === undefined
        ? current
        : {
            ...current,
            window: {
              ...current.window,
              orchestrated: {
                "": {
                  fromVersion: "2.89.0",
                  planToken: plan.planToken,
                  notAfter: 0,
                  boundMs: 1,
                  pending: true as const,
                  observed: { version: "2.90.0", processId: 100, startedAt: 1, at: 1 },
                },
              },
            },
          },
    );
    const home = fleetSnapshot("home");
    const host = OpenCodexUpdateHost.of({
      ...f.ops.host,
      member: (alias) =>
        Effect.succeed({
          alias,
          runningTurns: 0,
          snapshot: {
            ...home,
            runtime: { ...home.runtime, version: "2.90.0" },
            parityEvidence: { ...home.parityEvidence, processId: 100, startedAt: 1, observedAt: 0 },
          },
        }),
    });
    const blocked = {
      ...f.ops,
      host,
      healthProof: () =>
        Deferred.succeed(reached, undefined).pipe(
          Effect.andThen(Deferred.await(stop)),
          Effect.as({ startedAt: 1, processId: 100 }),
        ),
    };
    const running = yield* Effect.forkChild(
      recoverUncertain(blocked, yield* Ref.get(f.state), 1_000_000, scope),
    );
    yield* Deferred.await(reached);
    yield* Fiber.interrupt(running);
    expect((yield* Ref.get(f.state)).window?.orchestrated?.[""]?.pending).toBe(true);
    const result = yield* recoverUncertain(
      { ...f.ops, host },
      yield* Ref.get(f.state),
      1_000_000,
      scope,
    );
    expect(result).toBe("probation");
    expect((yield* Ref.get(f.state)).window?.probationEndsAt).toBeGreaterThan(1_000_000);
    expect(yield* Ref.get(f.rollbacks)).toBe(0);
    expect(yield* Ref.get(f.installs)).toBe(0);
  }),
);

it.effect("retries a forward decision interrupted just before its atomic write", () =>
  Effect.gen(function* () {
    const f = yield* fixture(false);
    yield* Ref.update(f.state, (current): State =>
      current.window === undefined
        ? current
        : {
            ...current,
            window: {
              ...current.window,
              orchestrated: {
                "": {
                  fromVersion: "2.89.0",
                  planToken: plan.planToken,
                  notAfter: 0,
                  boundMs: 1,
                  pending: true,
                  observed: { version: "2.90.0", processId: 100, startedAt: 1, at: 1 },
                },
              },
            },
          },
    );
    const home = fleetSnapshot("home");
    const host = OpenCodexUpdateHost.of({
      ...f.ops.host,
      member: (alias) =>
        Effect.succeed({
          alias,
          runningTurns: 0,
          snapshot: {
            ...home,
            runtime: { ...home.runtime, version: "2.90.0" },
            parityEvidence: { ...home.parityEvidence, processId: 100, startedAt: 1, observedAt: 0 },
          },
        }),
    });
    const reached = yield* Deferred.make<void>();
    const gate = yield* Deferred.make<void>();
    const blocked = {
      ...f.ops,
      host,
      mutateIfCurrent: (
        expected: State,
        change: (current: State, at: number) => State,
        after?: Effect.Effect<void>,
      ) =>
        Deferred.succeed(reached, undefined).pipe(
          Effect.andThen(Deferred.await(gate)),
          Effect.andThen(f.ops.mutateIfCurrent(expected, change, after)),
        ),
    };
    const running = yield* Effect.forkChild(
      recoverUncertain(blocked, yield* Ref.get(f.state), 1_000_000, scope),
    );
    yield* Deferred.await(reached);
    yield* Fiber.interrupt(running);
    expect((yield* Ref.get(f.state)).window?.orchestrated?.[""]?.pending).toBe(true);
    expect(
      yield* recoverUncertain({ ...f.ops, host }, yield* Ref.get(f.state), 1_000_000, scope),
    ).toBe("probation");
    expect(yield* Ref.get(f.rollbacks)).toBe(0);
    expect(yield* Ref.get(f.installs)).toBe(0);
  }),
);

it.effect("cancels a blocked recovery sync when the ceiling guard releases admission", () =>
  Effect.gen(function* () {
    const f = yield* fixture(false);
    yield* TestClock.setTime(1_000_000);
    yield* Ref.update(f.state, (current): State =>
      current.window === undefined
        ? current
        : {
            ...current,
            window: {
              ...current.window,
              orchestrated: {
                "": {
                  fromVersion: "2.89.0",
                  planToken: plan.planToken,
                  notAfter: 0,
                  boundMs: 1,
                  pending: true,
                  observed: { version: "2.90.0", processId: 100, startedAt: 1, at: 1 },
                },
              },
            },
          },
    );
    const home = fleetSnapshot("home");
    const host = OpenCodexUpdateHost.of({
      ...f.ops.host,
      member: (alias) =>
        Effect.succeed({
          alias,
          runningTurns: 0,
          snapshot: {
            ...home,
            runtime: { ...home.runtime, version: "2.90.0" },
            parityEvidence: { ...home.parityEvidence, processId: 100, startedAt: 1, observedAt: 0 },
          },
        }),
    });
    const started = yield* Deferred.make<void>();
    const cancelled = yield* Deferred.make<void>();
    const sync = OpenCodexSync.of({
      ...f.ops.sync,
      syncUpdatedMember: () =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Deferred.succeed(cancelled, undefined)),
        ),
    });
    const running = yield* Effect.forkChild(
      recoverUncertain({ ...f.ops, host, sync }, yield* Ref.get(f.state), 1_000_000, scope),
    );
    yield* Deferred.await(started);
    yield* f.ops.stateLock.withPermit(
      Effect.gen(function* () {
        yield* Ref.update(f.state, (current) => ({ ...current, members: [] }));
        yield* host.releaseAdmission(null);
        yield* Ref.set(f.ops.retainedHome, "none");
        yield* Deferred.succeed(yield* Ref.get(f.ops.overrunSignal), undefined);
      }),
    );
    expect(yield* Fiber.join(running)).toBe("uncertain");
    yield* Deferred.await(cancelled);
    expect((yield* Ref.get(f.state)).window?.probationEndsAt).toBeUndefined();
    expect(yield* Ref.get(f.holds)).toBe(0);
  }),
);
