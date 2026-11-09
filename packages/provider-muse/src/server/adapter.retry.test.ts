import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { testLayer, makeFakeMuse, makeHarness, startConversation } from "./test/adapterHelpers.ts";

describe("MuseAdapterV2 retry rows", () => {
  it.effect("keeps each retry chain on one row that settles when the turn moves on", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeMuse();
      const harness = yield* makeHarness(fake);
      const { nativeId } = yield* startConversation(harness, fake);
      const takeRetryRow = Effect.fnUntraced(function* () {
        const { turnItem } = yield* harness.takeEvent(
          "turn_item.updated",
          (event) => event.turnItem.type === "error",
        );
        return turnItem.type === "error" ? turnItem : undefined;
      });
      const retry = Effect.fnUntraced(function* (
        method: string,
        record: string,
        attempt: number,
        params: Record<string, unknown>,
      ) {
        yield* fake.emit(method, {
          turnId: nativeId,
          attempt,
          nextAttempt: attempt + 1,
          sourceRange: { first: { id: record }, last: { id: record } },
          ...params,
        });
        return yield* takeRetryRow();
      });
      const timeout = { maxAttempts: 2, retryDelayMs: 1_000, reason: "no first model event" };
      const turnRetry = yield* retry("turn/retryScheduled", "record-1", 1, timeout);
      assert.strictEqual(turnRetry?.status, "running");
      assert.strictEqual(turnRetry?.failure.message, "no first model event");
      assert.deepStrictEqual(turnRetry?.retry, { attempt: 1, maxAttempts: 1, retryDelayMs: 1_000 });
      const http = { maxAttempts: 10, errorKind: "server", httpStatus: 504, retryDelayMs: 1_000 };
      const modelRetry = yield* retry("turn/modelRetryScheduled", "record-2", 1, http);
      assert.strictEqual(modelRetry?.failure.message, "Model request failed (HTTP 504)");
      const nextChain = yield* retry("turn/retryScheduled", "record-3", 1, timeout);
      assert.strictEqual(new Set([turnRetry?.id, modelRetry?.id, nextChain?.id]).size, 3);
      const sameChain = yield* retry("turn/modelRetryScheduled", "record-4", 2, {
        ...http,
        httpStatus: 429,
        retryDelayMs: 60_000,
      });
      assert.strictEqual(sameChain?.id, modelRetry?.id);
      assert.deepStrictEqual(sameChain?.retry, {
        attempt: 2,
        maxAttempts: 9,
        retryDelayMs: 60_000,
      });

      yield* fake.emit("item/started", {
        turnId: nativeId,
        item: {
          itemId: "answer",
          turnId: nativeId,
          kind: "agentMessage",
          revision: 1,
          status: "inProgress",
        },
      });
      const recovered = [yield* takeRetryRow(), yield* takeRetryRow(), yield* takeRetryRow()];
      assert.sameMembers(
        recovered.map((row) => `${row?.id} ${row?.status} ${row?.failure.message}`),
        [
          `${turnRetry?.id} completed no first model event`,
          `${nextChain?.id} completed no first model event`,
          `${sameChain?.id} completed Model request failed (HTTP 429)`,
        ],
      );

      const stalled = yield* retry("turn/modelRetryScheduled", "record-5", 1, http);
      yield* fake.emit("turn/completed", {
        turnId: nativeId,
        terminal: "failed",
        error: { message: "Muse gave up" },
      });
      const stopped = yield* takeRetryRow();
      assert.deepStrictEqual([stopped?.id, stopped?.status], [stalled?.id, "interrupted"]);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});
