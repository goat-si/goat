import { assert, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Random from "effect/Random";
import * as Schedule from "effect/Schedule";
import { repairSchedule, retryDelayMs } from "./retryJitter.ts";

it.effect.each([0, 0.9999])(
  "durable repair keeps retrying within thirty seconds after repeated failures (draw=%s)",
  (draw) =>
    Effect.gen(function* () {
      const step = yield* Schedule.toStep(repairSchedule);
      const delays: number[] = [];
      for (let count = 0; count < 12; count++) {
        const [, delay] = yield* step(0, undefined);
        delays.push(Duration.toMillis(delay));
      }
      if (draw === 0) {
        assert.deepEqual(delays.slice(0, 6), [500, 1000, 2000, 4000, 8000, 15000]);
        assert.isTrue(delays.slice(5).every((delay) => delay === 15000));
      }
      assert.isTrue(delays.every((delay) => delay <= 30000));
      assert.isTrue(delays.slice(5).every((delay) => delay >= 15000));
    }).pipe(
      Effect.provideService(Random.Random, {
        nextIntUnsafe: () => 0,
        nextDoubleUnsafe: () => draw,
      }),
    ),
);

it.effect.each([5000, 300000])(
  "remote retry draws stay within their ceiling (%s ms)",
  (ceiling) => {
    let count = 0;
    return Effect.gen(function* () {
      assert.equal(yield* retryDelayMs(ceiling), ceiling / 2);
      assert.equal(yield* retryDelayMs(ceiling), ceiling * 0.75);
      assert.isAtMost(yield* retryDelayMs(ceiling), ceiling);
    }).pipe(
      Effect.provideService(Random.Random, {
        nextIntUnsafe: () => 0,
        nextDoubleUnsafe: () => (count++ === 0 ? 0 : count === 2 ? 0.5 : 0.9999),
      }),
    );
  },
);

it.effect("waiting for a run never sleeps past its deadline or returns a negative delay", () =>
  Effect.gen(function* () {
    assert.equal(yield* retryDelayMs(5000, 1000), 1000);
    assert.equal(yield* retryDelayMs(5000, 5000), 2500);
    assert.equal(yield* retryDelayMs(5000, -1), 0);
  }).pipe(
    Effect.provideService(Random.Random, {
      nextIntUnsafe: () => 0,
      nextDoubleUnsafe: () => 0,
    }),
  ),
);
