import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import type { ConnectionCatalogEntry } from "./catalog.ts";
import { PrimaryConnectionTarget } from "./model.ts";
import * as EnvironmentSupervisor from "./supervisor.ts";
import { TARGET, PREPARED_CONNECTION, awaitState, makeHarness } from "./supervisorTestSupport.ts";

const LOOPBACK_TARGET = new PrimaryConnectionTarget({
  environmentId: TARGET.environmentId,
  label: "This device",
  httpBaseUrl: "http://127.0.0.1:3773",
  wsBaseUrl: "ws://127.0.0.1:3773",
});
const LOOPBACK_ENTRY: ConnectionCatalogEntry = {
  target: LOOPBACK_TARGET,
  profile: Option.none(),
  enabled: true,
};
const LOOPBACK_PREPARED = {
  ...PREPARED_CONNECTION,
  target: LOOPBACK_TARGET,
  label: LOOPBACK_TARGET.label,
  httpBaseUrl: LOOPBACK_TARGET.httpBaseUrl,
  socketUrl: "ws://127.0.0.1:3773/ws",
};

describe("connected session health probes", () => {
  it.effect.each(["application-active-probe", "application-active"] as const)(
    "keeps a busy loopback session through %s and subsequent quick probes until it answers",
    (reason) =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const answer = yield* Deferred.make<void>();
        const harness = yield* makeHarness({
          prepare: () => Effect.succeed(LOOPBACK_PREPARED),
          probe: () =>
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(answer))),
        });
        const supervisor = yield* EnvironmentSupervisor.make(LOOPBACK_ENTRY, {
          initiallyDesired: true,
        }).pipe(Effect.provide(harness.dependencies));
        const connected = yield* awaitState(
          supervisor.state,
          (state) => state.phase === "connected",
        );
        const session = Option.getOrThrow(yield* SubscriptionRef.get(supervisor.session));

        yield* harness.wake(reason);
        yield* Deferred.await(started);
        yield* TestClock.adjust(1_000);
        yield* harness.wake("application-active-probe");
        for (const elapsed of [2_001, 12_000]) {
          yield* TestClock.adjust(elapsed);
          expect(yield* SubscriptionRef.get(supervisor.state)).toEqual(connected);
          expect(Option.getOrThrow(yield* SubscriptionRef.get(supervisor.session))).toBe(session);
          expect(yield* Ref.get(harness.sessionCount)).toBe(1);
          expect(yield* Ref.get(harness.releaseCount)).toBe(0);
        }

        yield* Deferred.succeed(answer, undefined);
        yield* TestClock.adjust(45_000);
        expect(yield* SubscriptionRef.get(supervisor.state)).toEqual(connected);
        expect(Option.getOrThrow(yield* SubscriptionRef.get(supervisor.session))).toBe(session);
        expect(yield* Ref.get(harness.sessionCount)).toBe(1);
        expect(yield* Ref.get(harness.releaseCount)).toBe(0);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect(
    "reconnects an unanswered loopback probe at 60 seconds despite subsequent signals",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const reconnectStarted = yield* Deferred.make<void>();
        const allowReconnect = yield* Deferred.make<void>();
        const harness = yield* makeHarness({
          prepare: (attempt) =>
            attempt === 1
              ? Effect.succeed(LOOPBACK_PREPARED)
              : Deferred.succeed(reconnectStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(allowReconnect)),
                  Effect.as(LOOPBACK_PREPARED),
                ),
          probe: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        });
        const supervisor = yield* EnvironmentSupervisor.make(LOOPBACK_ENTRY, {
          initiallyDesired: true,
        }).pipe(Effect.provide(harness.dependencies));
        const connected = yield* awaitState(
          supervisor.state,
          (state) => state.phase === "connected",
        );

        yield* harness.wake("application-active-probe");
        yield* Deferred.await(started);
        yield* TestClock.adjust(1_000);
        yield* harness.wake("application-active-probe");
        yield* TestClock.adjust(58_999);
        expect(yield* SubscriptionRef.get(supervisor.state)).toEqual(connected);
        expect(yield* Ref.get(harness.releaseCount)).toBe(0);

        yield* TestClock.adjust(1);
        yield* Deferred.await(reconnectStarted);
        expect(yield* Ref.get(harness.releaseCount)).toBe(1);
        expect(Option.isNone(yield* SubscriptionRef.get(supervisor.session))).toBe(true);
        yield* Deferred.succeed(allowReconnect, undefined);
        yield* awaitState(
          supervisor.state,
          (state) => state.phase === "connected" && state.generation === 2,
        );
        expect(yield* Ref.get(harness.sessionCount)).toBe(2);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("reconnects immediately when the loopback socket closes during a pending probe", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        prepare: () => Effect.succeed(LOOPBACK_PREPARED),
        probe: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LOOPBACK_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("application-active-probe");
      yield* Deferred.await(started);
      yield* harness.closeLatestSession();
      const reconnected = yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
      expect(reconnected.attempt).toBe(1);
      expect(yield* Ref.get(harness.sessionCount)).toBe(2);
      expect(yield* Ref.get(harness.releaseCount)).toBe(1);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect.each([
    { reason: "application-active-probe", timeoutMs: 3_000, shorten: false },
    { reason: "application-active", timeoutMs: 15_000, shorten: false },
    { reason: "application-active", timeoutMs: 4_000, shorten: true },
  ] as const)("keeps remote probe deadline $timeoutMs ms ($reason, shorten=$shorten)", (test) =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        probe: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(
        { target: TARGET, profile: Option.none(), enabled: true },
        { initiallyDesired: true },
      ).pipe(Effect.provide(harness.dependencies));
      const connected = yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake(test.reason);
      yield* Deferred.await(started);
      yield* TestClock.adjust(1_000);
      if (test.shorten) yield* harness.wake("application-active-probe");
      yield* TestClock.adjust(test.timeoutMs - 1_001);
      expect(yield* SubscriptionRef.get(supervisor.state)).toEqual(connected);
      expect(yield* Ref.get(harness.releaseCount)).toBe(0);
      yield* TestClock.adjust(1);
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
      expect(yield* Ref.get(harness.sessionCount)).toBe(2);
      expect(yield* Ref.get(harness.releaseCount)).toBe(1);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
