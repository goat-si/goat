import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import {
  BearerConnectionProfile,
  type ConnectionCatalogEntry,
  type ConnectionRoute,
} from "./catalog.ts";
import {
  makeEstablishmentGate,
  type EstablishmentPriority,
  type EstablishmentSlot,
} from "./establishmentGate.ts";
import { BearerConnectionTarget } from "./model.ts";
import * as EnvironmentSupervisor from "./supervisor.ts";
import { TARGET, awaitState, makeHarness } from "./supervisorTestSupport.ts";

type Gate = ReturnType<typeof makeEstablishmentGate>;

/** Holds a slot until `until` ends; returns once the slot is held. */
const occupy = Effect.fn("test.occupy")(function* (gate: Gate, until: Effect.Effect<void>) {
  const held = yield* Deferred.make<void>();
  const fiber = yield* Effect.scoped(
    gate("direct")(Effect.never).pipe(
      Effect.andThen(Deferred.succeed(held, undefined)),
      Effect.andThen(until),
    ),
  ).pipe(Effect.forkChild({ startImmediately: true }));
  yield* Deferred.await(held);
  return fiber;
});

function bearerRoute(connectionId: string, host: string): ConnectionRoute {
  const { environmentId, label } = TARGET;
  return {
    target: new BearerConnectionTarget({ environmentId, label, connectionId }),
    profile: Option.some(
      new BearerConnectionProfile({
        connectionId,
        environmentId,
        label,
        httpBaseUrl: `https://${host}/`,
        wsBaseUrl: `wss://${host}/`,
      }),
    ),
  };
}
// Two routes, so setup first waits on route checks without reporting a route's progress.
const ENTRY: ConnectionCatalogEntry = {
  ...bearerRoute("bearer:lan", "lan.example.test"),
  alternateRoutes: [bearerRoute("bearer:tailnet", "tailnet.example.test")],
  enabled: true,
};

describe("EstablishmentGate", () => {
  it.effect("admits queued direct setups before proxied ones, one per freed slot", () =>
    Effect.gen(function* () {
      const gate = makeEstablishmentGate({ slots: 1, holdLimit: "1 hour" });
      const free = yield* Deferred.make<void>();
      yield* occupy(gate, Deferred.await(free));
      const admitted = yield* Ref.make<ReadonlyArray<string>>([]);
      const finish = yield* Deferred.make<void>();
      const queue = (name: string, priority: EstablishmentPriority) =>
        Effect.scoped(
          gate(priority)(Effect.never).pipe(
            Effect.andThen(Ref.update(admitted, (names) => [...names, name])),
            Effect.andThen(Deferred.await(finish)),
          ),
        ).pipe(Effect.forkChild({ startImmediately: true }));
      yield* queue("proxied-1", "proxied");
      yield* queue("direct", "direct");
      const last = yield* queue("proxied-2", "proxied");

      yield* Deferred.succeed(free, undefined);
      yield* Deferred.succeed(finish, undefined);
      yield* Fiber.join(last);

      expect(yield* Ref.get(admitted)).toEqual(["direct", "proxied-1", "proxied-2"]);
    }),
  );

  it.effect("frees the slot of a setup that outlasts the hold limit", () =>
    Effect.gen(function* () {
      const gate = makeEstablishmentGate({ slots: 1, holdLimit: "5 seconds" });
      yield* occupy(gate, Effect.never);
      const waiting = yield* Effect.scoped(gate("direct")(Effect.never)).pipe(
        Effect.forkChild({ startImmediately: true }),
      );

      yield* TestClock.adjust("5 seconds");
      expect((yield* Fiber.join(waiting))._tag).toBe("Admitted");
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("returns the slot when a waiter withdraws, is interrupted, or ends its scope", () =>
    Effect.gen(function* () {
      const gate = makeEstablishmentGate({ slots: 1, holdLimit: "1 hour" });
      const free = yield* Deferred.make<void>();
      const holder = yield* occupy(gate, Deferred.await(free));
      const withdraw = yield* Deferred.make<string>();
      const withdrawing = yield* Effect.scoped(gate("direct")(Deferred.await(withdraw))).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      const interrupted = yield* Effect.scoped(gate("direct")(Effect.never)).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.succeed(withdraw, "disconnected");
      expect(yield* Fiber.join(withdrawing)).toEqual({ _tag: "Withdrawn", value: "disconnected" });
      yield* Fiber.interrupt(interrupted);
      yield* Deferred.succeed(free, undefined);
      yield* Fiber.join(holder);

      // Each of those gave the single slot back, so this setup is admitted without waiting.
      const admission = yield* Effect.scoped(gate("proxied")(Effect.never));
      expect(admission._tag).toBe("Admitted");
    }),
  );

  it.effect("returns the slot of a waiter interrupted right after the slot passed to it", () =>
    Effect.gen(function* () {
      const gate = makeEstablishmentGate({ slots: 1, holdLimit: "1 hour" });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const held = yield* gate("direct")(Effect.never);
          const waiter = yield* Effect.scoped(gate("direct")(Effect.never)).pipe(
            Effect.forkChild({ startImmediately: true }),
          );
          if (held._tag === "Admitted") yield* held.release;
          yield* Fiber.interrupt(waiter);
        }),
      );

      const admission = yield* Effect.scoped(gate("proxied")(Effect.never));
      expect(admission._tag).toBe("Admitted");
    }),
  );
});

describe("EnvironmentSupervisor with a setup slot", () => {
  const queuedBehindHolder = Effect.fn("test.queuedBehindHolder")(function* () {
    const gate = makeEstablishmentGate({ slots: 1, holdLimit: "1 hour" });
    const free = yield* Deferred.make<void>();
    yield* occupy(gate, Deferred.await(free));
    const queued = yield* Deferred.make<void>();
    const establishmentSlot: EstablishmentSlot = (whileQueued) =>
      Deferred.succeed(queued, undefined).pipe(Effect.andThen(gate("proxied")(whileQueued)));
    const routeChecks = yield* Deferred.make<void>();
    const harness = yield* makeHarness({
      checkRoute: () => Deferred.await(routeChecks).pipe(Effect.as("unchecked" as const)),
    });
    const supervisor = yield* EnvironmentSupervisor.make(ENTRY, {
      initiallyDesired: true,
      establishmentSlot,
    }).pipe(Effect.provide(harness.dependencies));
    yield* Deferred.await(queued);
    return {
      harness,
      supervisor,
      freeSlot: Deferred.succeed(free, undefined),
      answerRouteChecks: Deferred.succeed(routeChecks, undefined),
    };
  });

  it.effect("does not count time queued for a slot toward the setup timeout", () =>
    Effect.gen(function* () {
      const { harness, supervisor, freeSlot, answerRouteChecks } = yield* queuedBehindHolder();

      yield* TestClock.adjust("1 minute");
      expect((yield* SubscriptionRef.get(supervisor.state)).phase).toBe("connecting");
      expect(yield* Ref.get(harness.prepareCount)).toBe(0);

      yield* freeSlot;
      yield* TestClock.adjust("100 millis");
      expect((yield* SubscriptionRef.get(supervisor.state)).phase).toBe("connecting");
      yield* answerRouteChecks;
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      expect(yield* Ref.get(harness.prepareCount)).toBe(1);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("shows connecting while it waits for a slot", () =>
    Effect.gen(function* () {
      const gate = makeEstablishmentGate({ slots: 1, holdLimit: "1 hour" });
      yield* occupy(gate, Effect.never);
      const harness = yield* makeHarness();
      const supervisor = yield* EnvironmentSupervisor.make(ENTRY, {
        establishmentSlot: gate("proxied"),
      }).pipe(Effect.provide(harness.dependencies));
      expect((yield* SubscriptionRef.get(supervisor.state)).phase).toBe("available");

      yield* supervisor.connect;
      yield* awaitState(supervisor.state, (state) => state.phase === "connecting");
      expect(yield* Ref.get(harness.prepareCount)).toBe(0);
    }),
  );

  it.effect("stops waiting for a slot when disconnected", () =>
    Effect.gen(function* () {
      const { harness, supervisor, freeSlot, answerRouteChecks } = yield* queuedBehindHolder();
      yield* answerRouteChecks;

      yield* supervisor.disconnect;
      yield* awaitState(supervisor.state, (state) => state.phase === "available");
      yield* freeSlot;
      yield* supervisor.connect;
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      expect(yield* Ref.get(harness.prepareCount)).toBe(1);
    }),
  );
});
