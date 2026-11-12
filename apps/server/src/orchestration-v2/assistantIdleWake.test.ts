import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { makePendingSnapshotHold } from "./assistantIdleWake.ts";

it.effect(
  "a pending-work hold never lets go while a pulled provider event waits to be processed",
  () =>
    Effect.gen(function* () {
      const hold = makePendingSnapshotHold(() => Effect.void);
      assert.isTrue(yield* hold.holds());
      // The merge pulled an event that sits behind an idle wake in the merged stream.
      hold.providerEventPulled();
      yield* TestClock.adjust("10 seconds");
      assert.isTrue(yield* hold.holds());
      hold.providerEvent();
      assert.isTrue(yield* hold.holds());
      yield* TestClock.adjust("5 seconds");
      assert.isFalse(yield* hold.holds());
    }),
);
