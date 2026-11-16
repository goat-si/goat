import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { Atom, AtomRegistry } from "effect/reactivity";

import { EnvironmentId } from "@goat/contracts";

import { PrimaryConnectionTarget } from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { TARGET, awaitState, makeHarness } from "../connection/supervisorTestSupport.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createAtomCommandScheduler, createEnvironmentCommand } from "./runtime.ts";

// Publication order is page-wide, so every test names its own computer.
const makeComputer = Effect.fn("TestCommandSessionSupervisor.makeComputer")(function* (
  name: string,
  initiallyDesired: boolean,
) {
  const target = new PrimaryConnectionTarget({
    environmentId: EnvironmentId.make(name),
    label: TARGET.label,
    httpBaseUrl: TARGET.httpBaseUrl,
    wsBaseUrl: TARGET.wsBaseUrl,
  });
  const harness = yield* makeHarness();
  const supervisor = yield* EnvironmentSupervisor.make(
    { target, profile: Option.none(), enabled: true },
    { initiallyDesired },
  ).pipe(Effect.provide(harness.dependencies));
  const runtime = Atom.runtime(
    Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, {
      run: (_environmentId, effect) =>
        Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    } as EnvironmentRegistry.EnvironmentRegistry["Service"]),
  );
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  };
  const headStarted = yield* Deferred.make<void>();
  const releaseHead = yield* Deferred.make<void>();
  const ranOn: Array<RpcSession | null> = [];
  const head = createEnvironmentCommand(runtime, {
    label: "test:head",
    scheduler,
    concurrency,
    execute: () =>
      Deferred.succeed(headStarted, undefined).pipe(Effect.andThen(Deferred.await(releaseHead))),
  });
  const queued = createEnvironmentCommand(runtime, {
    label: "test:queued",
    scheduler,
    concurrency,
    execute: () =>
      EnvironmentSupervisor.EnvironmentSupervisor.pipe(
        Effect.flatMap((current) => SubscriptionRef.get(current.session)),
        Effect.map((session) => {
          ranOn.push(Option.getOrNull(session));
        }),
      ),
  });
  const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (value) =>
    Effect.sync(() => value.dispose()),
  );
  const command = { environmentId: target.environmentId, input: undefined };
  return {
    harness,
    supervisor,
    ranOn,
    currentSession: SubscriptionRef.get(supervisor.session).pipe(Effect.map(Option.getOrNull)),
    headStarted: Deferred.await(headStarted),
    releaseHead: Deferred.succeed(releaseHead, undefined),
    pressHead: () => head.run(registry, command),
    press: () => queued.run(registry, command),
  };
});

describe("queued computer commands on the real supervisor", () => {
  it.effect("a command queued on one session does not reach the session that replaced it", () =>
    Effect.gen(function* () {
      const computer = yield* makeComputer("replaced-session", true);
      yield* awaitState(computer.supervisor.state, (state) => state.phase === "connected");
      const first = yield* computer.currentSession;
      const head = computer.pressHead();
      yield* computer.headStarted;
      const queued = computer.press();

      yield* computer.harness.closeLatestSession();
      yield* awaitState(computer.supervisor.state, (state) => state.phase === "backoff");
      yield* TestClock.adjust("3 seconds");
      yield* awaitState(
        computer.supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
      const second = yield* computer.currentSession;
      expect(second).not.toBeNull();
      expect(second).not.toBe(first);
      yield* computer.releaseHead;

      expect((yield* Effect.promise(() => head))._tag).toBe("Success");
      const result = yield* Effect.promise(() => queued);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(Cause.squash(result.cause)).toMatchObject({
          _tag: "EnvironmentRpcUnavailableError",
          message: `${TARGET.label} reconnected before this ran, so it was not sent. Try again.`,
        });
      }
      expect(computer.ranOn).toEqual([]);
    }).pipe(Effect.provide(TestClock.layer()), Effect.scoped),
  );

  it.effect("a command queued on a session that stays up runs on it", () =>
    Effect.gen(function* () {
      const computer = yield* makeComputer("stays-up", true);
      yield* awaitState(computer.supervisor.state, (state) => state.phase === "connected");
      const session = yield* computer.currentSession;
      const head = computer.pressHead();
      yield* computer.headStarted;
      const queued = computer.press();
      yield* computer.releaseHead;

      expect((yield* Effect.promise(() => head))._tag).toBe("Success");
      expect((yield* Effect.promise(() => queued))._tag).toBe("Success");
      expect(computer.ranOn).toEqual([session]);
    }).pipe(Effect.provide(TestClock.layer()), Effect.scoped),
  );

  it.effect("a press made before the first connection runs once it connects", () =>
    Effect.gen(function* () {
      const computer = yield* makeComputer("first-connection", false);
      const head = computer.pressHead();
      yield* computer.headStarted;
      const queued = computer.press();
      yield* computer.supervisor.connect;
      yield* awaitState(computer.supervisor.state, (state) => state.phase === "connected");
      yield* computer.releaseHead;

      expect((yield* Effect.promise(() => head))._tag).toBe("Success");
      expect((yield* Effect.promise(() => queued))._tag).toBe("Success");
      expect(computer.ranOn).toEqual([yield* computer.currentSession]);
    }).pipe(Effect.provide(TestClock.layer()), Effect.scoped),
  );
});
