import { assert, describe, it } from "@effect/vitest";
import * as TestClock from "effect/testing/TestClock";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Worker from "./MemoryWorker.ts";
import { countingTracer } from "../observability/countingTracer.testkit.ts";
import { now, live, seed } from "./MemoryWorker.testkit.ts";

// Sweeps run every few seconds on the server's one thread, so repeated source reads are a cost.
describe("MemoryWorker sweep cost", () => {
  it.effect("fails a summary the model keeps rejecting instead of retrying it forever", () => {
    let calls = 0;
    return Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(now));
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const worker = yield* Worker.MemoryWorker;
      for (let pass = 0; pass < Worker.MEMORY_GENERATION_MAX_ATTEMPTS + 3; pass++) {
        yield* worker.sweepDue();
        yield* TestClock.adjust(Worker.MEMORY_CONTINUATION_SCAN_INTERVAL_MS);
      }
      assert.strictEqual(calls, Worker.MEMORY_GENERATION_MAX_ATTEMPTS);
      assert.deepStrictEqual(
        yield* sql`SELECT status,attempt FROM memory_outbox WHERE kind IN ('summary','consolidate')`,
        [{ status: "failed", attempt: Worker.MEMORY_GENERATION_MAX_ATTEMPTS }],
      );
    }).pipe(
      Effect.provide(
        live(
          () => "Memory evidence or execution is invalid.",
          () => {
            calls += 1;
          },
        ),
      ),
    );
  });
  it.effect("reads no thread source while memory is off", () => {
    const spans = new Map<string, number>();
    return Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(now));
      yield* seed;
      const worker = yield* Worker.MemoryWorker;
      const sweep = worker.sweepDue().pipe(Effect.withTracer(countingTracer(spans)));
      yield* sweep;
      yield* TestClock.adjust(Worker.MEMORY_CONTINUATION_SCAN_INTERVAL_MS);
      yield* sweep;
      assert.strictEqual(spans.get("MemoryWorker.catchUp"), 2);
      assert.isUndefined(spans.get("MemoryWorker.readSource"));
      assert.isUndefined(spans.get("MemoryWorker.scanSourceStream"));
    }).pipe(Effect.provide(live(false, undefined, false, 0, true)));
  });
});
