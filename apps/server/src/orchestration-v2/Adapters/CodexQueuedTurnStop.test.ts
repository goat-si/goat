import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";

import {
  makeStoppedQueuedTurns,
  stopLateQueuedTurn,
  stopQueuedTurn,
} from "./CodexQueuedTurnStop.ts";

describe("CodexQueuedTurnStop", () => {
  it.effect("keeps interrupting a late-started queued turn until Codex accepts", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const interrupt = Effect.suspend(() =>
        ++attempts < 5 ? Effect.fail("busy" as const) : Effect.void,
      );
      const stop = yield* stopLateQueuedTurn(interrupt, () => true).pipe(Effect.forkScoped);
      yield* TestClock.adjust("5 seconds");
      yield* TestClock.adjust("5 seconds");
      yield* Fiber.join(stop);
      assert.equal(attempts, 5);
    }).pipe(Effect.scoped),
  );

  it.effect("stops retrying once Codex has ended the late-started turn", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const interrupt = Effect.suspend(() => (++attempts, Effect.fail("gone" as const)));
      yield* stopLateQueuedTurn(interrupt, () => attempts < 3);
      assert.equal(attempts, 3);
    }),
  );

  const queuedTurn = Effect.gen(function* () {
    return {
      nativeTurnId: "queued-turn",
      nativeStartReady: yield* Deferred.make<void>(),
      subagent: null,
      providerThread: { nativeThreadRef: { nativeId: "thread" } },
    };
  });

  it.effect("leaves a queued turn that ended before Stop gave up on it unrecorded", () =>
    Effect.gen(function* () {
      const stopped = makeStoppedQueuedTurns();
      let settled = false;
      const stop = yield* stopQueuedTurn({
        context: yield* queuedTurn,
        stopped,
        withPermit: (effect) => effect,
        activeTurns: Effect.succeed(new Map()),
        interrupt: () => Effect.die("an ended turn is not interrupted"),
        settle: Effect.sync(() => (settled = true)),
        full: Effect.die("an ended turn does not need room"),
      }).pipe(Effect.forkScoped);
      yield* TestClock.adjust("10 seconds");
      yield* Fiber.join(stop);
      assert.isFalse(settled);
      assert.isFalse(stopped.has("queued-turn"));
    }).pipe(Effect.scoped),
  );

  it.effect("keeps a queued turn active and fails Stop when no more stopped turns fit", () =>
    Effect.gen(function* () {
      const stopped = makeStoppedQueuedTurns(1);
      assert.isTrue(stopped.add("earlier-turn", "thread"));
      let settled = false;
      const context = yield* queuedTurn;
      const stop = yield* stopQueuedTurn({
        context,
        stopped,
        withPermit: (effect) => effect,
        activeTurns: Effect.succeed(new Map([[context.nativeTurnId, context]])),
        interrupt: () => Effect.die("a queued turn that never started is not interrupted"),
        settle: Effect.sync(() => (settled = true)),
        full: Effect.fail("full" as const),
      }).pipe(Effect.flip, Effect.forkScoped);
      yield* TestClock.adjust("10 seconds");
      assert.equal(yield* Fiber.join(stop), "full");
      assert.isFalse(settled);
      assert.isFalse(stopped.has("queued-turn"));
      stopped.unloadThread("thread");
      assert.isTrue(stopped.add("queued-turn", "thread"));
    }).pipe(Effect.scoped),
  );
});
