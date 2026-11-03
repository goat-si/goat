import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import * as EnvironmentSupervisor from "./supervisor.ts";
import type { ConnectionAttemptError } from "./model.ts";
import { TARGET, awaitState, makeHarness, transient } from "./supervisorTestSupport.ts";

const entry = { target: TARGET, profile: Option.none(), enabled: true };
const opened = (probe: Effect.Effect<void, ConnectionAttemptError> = Effect.void) =>
  Effect.succeed({ probe, drainIo: Effect.void });
const connected = Effect.fn("TestConnectedLease.connected")(function* (
  options?: Parameters<typeof makeHarness>[0],
) {
  const harness = yield* makeHarness(options);
  const supervisor = yield* EnvironmentSupervisor.make(entry, { initiallyDesired: true }).pipe(
    Effect.provide(harness.dependencies),
  );
  yield* awaitState(supervisor.state, (state) => state.phase === "connected");
  return { ...harness, supervisor };
});

it.effect("focus probe timeout keeps lease", () =>
  Effect.gen(function* () {
    const h = yield* connected({ probe: () => Effect.never });
    yield* h.wake("application-active-probe");
    yield* TestClock.adjust("20 seconds");
    expect(yield* Ref.get(h.sessionCount)).toBe(1);
    expect((yield* SubscriptionRef.get(h.supervisor.state)).phase).toBe("connected");
  }),
);

it.effect("focus probe RPC failure keeps lease", () =>
  Effect.gen(function* () {
    const h = yield* connected({ probe: () => Effect.fail(transient()) });
    yield* h.wake("application-active-probe");
    yield* TestClock.adjust("1 second");
    expect(yield* Ref.get(h.sessionCount)).toBe(1);
    expect((yield* SubscriptionRef.get(h.supervisor.state)).phase).toBe("connected");
  }),
);

it.effect(
  "network change + identity ok + fresh socket answers + old silent -> one replacement",
  () =>
    Effect.gen(function* () {
      const h = yield* connected({ openProbeSocket: opened() });
      yield* h.wake("network-changed");
      yield* TestClock.adjust("4999 millis");
      expect(yield* Ref.get(h.sessionCount)).toBe(1);
      yield* TestClock.adjust("1 millis");
      expect(yield* Ref.get(h.sessionCount)).toBe(2);
      expect(yield* Ref.get(h.releaseCount)).toBe(1);
    }),
);

it.effect("network change + old socket frame arrives -> kept", () =>
  Effect.gen(function* () {
    const frames = yield* Ref.make(0);
    const started = yield* Deferred.make<void>();
    const h = yield* connected({
      inboundFrames: Ref.get(frames),
      openProbeSocket: Deferred.succeed(started, undefined).pipe(Effect.andThen(opened())),
    });
    yield* h.wake("network-changed");
    yield* TestClock.adjust("2 seconds");
    expect(yield* Deferred.isDone(started)).toBe(true);
    yield* Ref.update(frames, (n) => n + 1);
    yield* TestClock.adjust("8 seconds");
    expect(yield* Ref.get(h.sessionCount)).toBe(1);
  }),
);

it.effect("offline signal -> no replacement", () =>
  Effect.gen(function* () {
    const h = yield* connected({ openProbeSocket: opened(), probe: () => Effect.never });
    yield* h.setNetworkStatus("offline");
    yield* h.wake("application-active-long");
    yield* TestClock.adjust("10 seconds");
    expect(yield* Ref.get(h.sessionCount)).toBe(1);
  }),
);

it.effect("offline arrives during a running check -> kept", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const answer = yield* Deferred.make<void>();
    const h = yield* connected({
      openProbeSocket: opened(
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(answer))),
      ),
    });
    yield* h.wake("network-changed");
    yield* TestClock.adjust(0);
    expect(yield* Deferred.isDone(started)).toBe(true);
    yield* h.setNetworkStatus("offline");
    yield* Deferred.succeed(answer, undefined);
    yield* TestClock.adjust("10 seconds");
    expect(yield* Ref.get(h.sessionCount)).toBe(1);
  }),
);

it.effect("long resume, rtt 3 s, first old frame at 7 s -> one replacement", () =>
  Effect.gen(function* () {
    const frames = yield* Ref.make(0);
    const h = yield* connected({
      inboundFrames: Ref.get(frames),
      openProbeSocket: opened(Effect.sleep("3 seconds")),
    });
    yield* h.wake("application-active-long");
    yield* TestClock.adjust("6 seconds");
    expect(yield* Ref.get(h.sessionCount)).toBe(2);
    yield* TestClock.adjust("1 second");
    yield* Ref.update(frames, (n) => n + 1);
    expect(yield* Ref.get(h.releaseCount)).toBe(1);
  }),
);

it.effect("probe socket open fails -> kept", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const h = yield* connected({
      openProbeSocket: Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.fail(transient())),
      ),
    });
    yield* h.wake("network-changed");
    yield* TestClock.adjust("10 seconds");
    expect(yield* Deferred.isDone(started)).toBe(true);
    expect(yield* Ref.get(h.sessionCount)).toBe(1);
  }),
);

it.effect("newer event restarts window", () =>
  Effect.gen(function* () {
    const h = yield* connected({ openProbeSocket: opened() });
    yield* h.wake("network-changed");
    yield* TestClock.adjust("4 seconds");
    yield* h.wake("network-changed");
    yield* TestClock.adjust("4 seconds");
    expect(yield* Ref.get(h.sessionCount)).toBe(1);
    yield* TestClock.adjust("1 second");
    expect(yield* Ref.get(h.sessionCount)).toBe(2);
  }),
);

it.effect("fresh probe RPC failure keeps the old socket", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const h = yield* connected({
      openProbeSocket: opened(
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.fail(transient()))),
      ),
    });
    yield* h.wake("network-changed");
    yield* TestClock.adjust("10 seconds");
    expect(yield* Deferred.isDone(started)).toBe(true);
    expect(yield* Ref.get(h.sessionCount)).toBe(1);
  }),
);
