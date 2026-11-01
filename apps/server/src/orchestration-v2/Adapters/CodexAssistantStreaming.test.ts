import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { TestClock } from "effect/testing";
import {
  makeProviderTextDeltaCoalescer,
  type ProviderTextDeltaUpdate,
} from "./ProviderTextDeltaCoalescer.ts";

describe("CodexAdapterV2 assistant message streaming", () => {
  it.effect("flushes buffered text synchronously before item and turn completion", () =>
    Effect.gen(function* () {
      const updates = yield* Ref.make<ReadonlyArray<ProviderTextDeltaUpdate>>([]);
      const coalescer = yield* makeProviderTextDeltaCoalescer({
        flushIntervalMs: 50,
        emit: (update) => Ref.update(updates, (current) => [...current, update]),
      });

      yield* coalescer.append({ turnId: "turn-1", itemId: "message-1", delta: "item final" });
      const completedText = yield* coalescer.complete({
        turnId: "turn-1",
        itemId: "message-1",
      });
      yield* coalescer.append({ turnId: "turn-1", itemId: "message-2", delta: "turn final" });
      yield* coalescer.flushTurn("turn-1");

      assert.equal(completedText, "item final");
      assert.deepEqual(yield* Ref.get(updates), [
        { turnId: "turn-1", itemId: "message-1", text: "item final", completed: true },
        { turnId: "turn-1", itemId: "message-2", text: "turn final", completed: true },
      ]);
      yield* TestClock.adjust("50 millis");
      assert.equal((yield* Ref.get(updates)).length, 2);
    }),
  );
});
