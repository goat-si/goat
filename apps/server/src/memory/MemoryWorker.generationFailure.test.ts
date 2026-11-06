import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as Store from "./MemoryStore.ts";
import * as Worker from "./MemoryWorker.ts";
import { environmentId, live, now, seed, space } from "./MemoryWorker.testkit.ts";

const read = Effect.gen(function* () {
  const store = yield* Store.MemoryStore;
  return yield* store.readGenerationFailure({ environmentId, memorySpaceId: space });
});

describe("MemoryWorker generation failures", () => {
  it.effect("reports a failing conversation until a later summary of it succeeds", () => {
    let failing = true;
    return Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(now));
      yield* seed;
      const worker = yield* Worker.MemoryWorker;
      yield* worker.sweepDue();
      assert.deepStrictEqual(yield* read, {
        threads: 1,
        failureCode: "generation_failed",
        retrying: true,
      });
      failing = false;
      yield* TestClock.adjust(Worker.memoryRetryDelay(1));
      yield* worker.sweepDue();
      assert.isUndefined(yield* read);
    }).pipe(
      Effect.provide(
        live(() => (failing ? "Memory evidence or execution is invalid." : undefined)),
      ),
    );
  });
  it.effect("reports a failure GOAT stopped retrying as not retrying", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(now));
      yield* seed;
      const worker = yield* Worker.MemoryWorker;
      for (let pass = 0; pass < Worker.MEMORY_GENERATION_MAX_ATTEMPTS + 1; pass++) {
        yield* worker.sweepDue();
        yield* TestClock.adjust(Worker.MEMORY_CONTINUATION_SCAN_INTERVAL_MS);
      }
      assert.deepStrictEqual(yield* read, {
        threads: 1,
        failureCode: "generation_failed",
        retrying: false,
      });
    }).pipe(Effect.provide(live(() => "Memory evidence or execution is invalid."))),
  );
});
