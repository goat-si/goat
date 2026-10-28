import { assert, describe, it } from "@effect/vitest";
import {
  type AgentCursorEvent,
  type ComputerUseOverlayCommand,
  type ComputerUseOverlayHideReason,
  EnvironmentId,
} from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";

import { active, CONTROL, harness } from "./ComputerUseLeaseProxy.testkit.ts";

const identity = (sequence: number, generation = 1) => ({
  environmentId: EnvironmentId.make("environment"),
  runId: "run:one",
  turnId: "cell:one",
  targetId: "target",
  generation,
  sequence,
});
// The overlay takes a show after its owner's hide only from a newer generation.
const show = (sequence: number, generation = 1): AgentCursorEvent => ({
  op: "show",
  identity: identity(sequence, generation),
  phase: "resting",
  pid: 4,
  windowId: 9,
});
const hide = (sequence: number, reason: ComputerUseOverlayHideReason): AgentCursorEvent => ({
  op: "hide",
  identity: identity(sequence),
  phase: "hidden",
  reason,
});
const listApps = (requestId: string, connectionGeneration: string, deadlineMillis = 60_000) => ({
  state: "primitive-request" as const,
  requestId,
  registrationId: "registration:one",
  controlId: CONTROL,
  connectionGeneration,
  runId: "run:one",
  turnId: "cell:one",
  callId: 0,
  deadlineMillis,
  tool: "list_apps",
  args: {},
});

// With no call's window to show on, the overlay draws each accepted cursor event as a hide.
const sequenceOf = (command: ComputerUseOverlayCommand) =>
  "identity" in command ? command.identity.sequence : undefined;

/**
 * A proxy whose overlay draws land in a queue. The draw for sequence 2 waits for hideGate, and the second
 * lease update holds the lifecycle lock until lockGate, as a slow manifest refresh would.
 */
const cursorHarness = Effect.fn(function* (
  gates: {
    readonly hideGate?: Deferred.Deferred<void>;
    readonly lockGate?: Deferred.Deferred<void>;
  } = {},
) {
  const draws = yield* Queue.unbounded<ComputerUseOverlayCommand>();
  const holding = yield* Deferred.make<void>();
  let applied = 0;
  const h = yield* harness({
    cursorEvents: true,
    overlay: (command) =>
      Queue.offer(draws, command).pipe(
        Effect.andThen(
          sequenceOf(command) === 2 && gates.hideGate !== undefined
            ? Deferred.await(gates.hideGate)
            : Effect.void,
        ),
      ),
    afterApplied: () =>
      ++applied === 2 && gates.lockGate !== undefined
        ? Deferred.succeed(holding, undefined).pipe(Effect.andThen(Deferred.await(gates.lockGate)))
        : Effect.void,
  });
  yield* h.push(active());
  const first = yield* h.driverStarted;
  const cursor = (event: AgentCursorEvent, connectionGeneration = first.connectionId) =>
    h.cursor({ state: "cursor-state", controlId: CONTROL, connectionGeneration, event });
  // Cursor events are handled one at a time, so a later event's draw proves the earlier one,
  // and any driver replacement it started, finished.
  const drawn = (sequence: number) =>
    Queue.take(draws).pipe(Effect.repeat({ until: (command) => sequenceOf(command) === sequence }));
  return { h, first, cursor, drawn, holding: Deferred.await(holding) };
});

describe("ComputerUseLeaseProxy and a window that turns private or is taken over", () => {
  it.effect("a private hide replaces the driver chain and the next call reaches the new one", () =>
    Effect.gen(function* () {
      const { h, first, cursor, drawn } = yield* cursorHarness();
      yield* cursor(show(1));
      yield* drawn(1);
      yield* h.sendPrimitive(listApps("request:old", first.connectionId));
      assert.equal((yield* h.nextDispatch).index, 0);
      yield* cursor(hide(2, "private"));
      assert.equal((yield* h.driverCutoff).connectionId, first.connectionId);
      // The call the old driver held may have acted, so it is cut off rather than settled.
      assert.equal((yield* h.primitiveReply).status, "unknown_outcome");
      const second = yield* h.driverStarted;
      assert.notEqual(second.connectionId, first.connectionId);
      yield* h.sendPrimitive(listApps("request:new", second.connectionId));
      assert.deepEqual((yield* h.nextToDriver).params, { name: "list_apps", arguments: {} });
    }),
  );

  it.effect("a takeover hide replaces the driver chain too", () =>
    Effect.gen(function* () {
      const { h, first, cursor } = yield* cursorHarness();
      yield* cursor(show(1));
      yield* cursor(hide(2, "takeover"));
      assert.equal((yield* h.driverCutoff).connectionId, first.connectionId);
      const second = yield* h.driverStarted;
      yield* h.sendPrimitive(listApps("request:new", second.connectionId));
      assert.deepEqual((yield* h.nextToDriver).params, { name: "list_apps", arguments: {} });
    }),
  );

  it.effect("a target's own end keeps the driver chain", () =>
    Effect.gen(function* () {
      const { h, first, cursor, drawn } = yield* cursorHarness();
      yield* cursor(show(1));
      yield* cursor(hide(2, "ended"));
      yield* cursor(show(3, 2));
      yield* drawn(3);
      yield* h.sendPrimitive(listApps("request:next", first.connectionId));
      assert.equal((yield* h.nextDispatch).index, 0);
      assert.equal(h.drivers.length, 1);
    }),
  );

  it.effect("a stale private hide, or one for another chain, replaces nothing", () =>
    Effect.gen(function* () {
      const { h, first, cursor, drawn } = yield* cursorHarness();
      yield* cursor(show(5));
      yield* drawn(5);
      // Older than the cursor the overlay holds, so the overlay rejects it.
      yield* cursor(hide(3, "private"));
      yield* cursor(hide(6, "takeover"), "connection:other");
      yield* cursor(show(7));
      yield* drawn(7);
      yield* h.sendPrimitive(listApps("request:next", first.connectionId));
      assert.equal((yield* h.nextDispatch).index, 0);
      assert.equal(h.drivers.length, 1);
    }),
  );

  it.effect("a call that overtakes an accepted private hide is refused and never sent", () =>
    Effect.gen(function* () {
      const lockGate = yield* Deferred.make<void>();
      const { h, first, cursor, drawn, holding } = yield* cursorHarness({ lockGate });
      yield* h.push(active());
      yield* holding;
      yield* cursor(show(1));
      yield* cursor(hide(2, "private"));
      yield* drawn(2);
      // The replacement waits for the lock; the old chain is already closed to calls.
      yield* h.sendPrimitive(listApps("request:overtaking", first.connectionId));
      assert.equal((yield* h.primitiveReply).status, "not_started");
      assert.equal(h.drivers.length, 1);
      assert.equal(yield* h.driverQueued, 0);
      yield* Deferred.succeed(lockGate, undefined);
      assert.equal((yield* h.driverCutoff).connectionId, first.connectionId);
      const second = yield* h.driverStarted;
      yield* h.sendPrimitive(listApps("request:new", second.connectionId));
      assert.deepEqual((yield* h.nextToDriver).params, { name: "list_apps", arguments: {} });
    }),
  );

  it.effect(
    "a private hide for a chain another replacement already closed leaves the new one",
    () =>
      Effect.gen(function* () {
        const hideGate = yield* Deferred.make<void>();
        const { h, first, cursor, drawn } = yield* cursorHarness({ hideGate });
        yield* cursor(show(1));
        yield* drawn(1);
        yield* h.sendPrimitive(listApps("request:stuck", first.connectionId, 30_000));
        assert.equal((yield* h.nextDispatch).index, 0);
        yield* cursor(hide(2, "private"));
        yield* drawn(2);
        // The stuck call's own replacement overtakes the hide's.
        yield* TestClock.adjust("31 seconds");
        assert.equal((yield* h.driverCutoff).connectionId, first.connectionId);
        const second = yield* h.driverStarted;
        yield* Deferred.succeed(hideGate, undefined);
        yield* cursor(show(3, 2), second.connectionId);
        yield* drawn(3);
        assert.equal(h.drivers.length, 2);
        yield* h.sendPrimitive(listApps("request:new", second.connectionId));
        assert.deepEqual((yield* h.nextToDriver).params, { name: "list_apps", arguments: {} });
      }),
  );
});
