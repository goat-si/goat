import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import * as SqlClient from "effect/sql/SqlClient";
import { ServerActivation } from "../serverActivation.ts";
import * as Worker from "./MemoryWorker.ts";
import { live } from "./MemoryWorker.testkit.ts";

it.effect("does not sweep before server activation, including periodic wakes", () => {
  let sweeps = 0;
  const tracer = Tracer.make({
    span: (options) => {
      if (options.name === "MemoryWorker.sweepDue") sweeps++;
      return new Tracer.NativeSpan(options);
    },
  });
  return Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const worker = yield* Worker.MemoryWorker;
      yield* worker.start();
      yield* TestClock.adjust("1 minute");
      assert.strictEqual(sweeps, 0);
      yield* Deferred.succeed(gate, undefined);
      yield* TestClock.adjust(0);
      assert.isAtLeast(sweeps, 1);
    }).pipe(Effect.scoped, Effect.provideService(ServerActivation, Deferred.await(gate)));
  }).pipe(Effect.provide(live()), Effect.withTracer(tracer));
});

it.effect("fails worker start when the thread hook watermark cannot be read", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DROP TABLE memory_outbox`;
    const worker = yield* Worker.MemoryWorker;
    const result = yield* worker
      .start()
      .pipe(
        Effect.exit,
        Effect.scoped,
        Effect.provideService(ServerActivation, Deferred.await(gate)),
      );
    assert.isTrue(Exit.isFailure(result));
  }).pipe(Effect.provide(live())),
);
