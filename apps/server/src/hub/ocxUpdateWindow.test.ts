import { expect, it } from "@effect/vitest";
import { EnvironmentId } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { OpenCodexUpdateHost } from "./OpenCodexUpdateHost.ts";
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

const fixture = Effect.fn("OpenCodexWindowTest.fixture")(function* () {
  const boundary = yield* Deferred.make<void>();
  const resume = yield* Deferred.make<void>();
  const retainedHome = yield* Ref.make<AdmissionOwnership>("retained");
  const nextAt = yield* Ref.make(0);
  const holds = yield* Ref.make(1);
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
    latestRelease: Effect.succeed(undefined),
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
    install: () => Effect.succeed(false),
    holdAdmission: () => Ref.update(holds, (n) => n + 1).pipe(Effect.as(true)),
    releaseAdmission: () => Ref.update(holds, (n) => n - 1),
  });
  const mutate = Effect.fn("OpenCodexWindowTest.mutate")(function* (
    change: (current: State, at: number) => State,
  ) {
    const next = change(yield* Ref.get(state), 0);
    yield* Ref.set(state, next);
    if (next.window?.orchestrated?.[""]?.settled) {
      yield* Deferred.succeed(boundary, undefined);
      yield* Deferred.await(resume);
    }
  });
  const ops = {
    host,
    retainedHome,
    nextAt,
    mutate,
    record: () => Effect.void,
    rollBack: () => Effect.succeed(true),
    healthy: () => Effect.succeed(true),
  };
  return { state, holds, ops, boundary, resume };
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
