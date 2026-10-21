import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import { describeGitStall, type GitStall, withGitStallTimeout } from "./gitStallTimeout.ts";

const STALL_MS = 120_000;

class Stalled {
  readonly stall: GitStall;
  constructor(stall: GitStall) {
    this.stall = stall;
  }
}

describe("withGitStallTimeout", () => {
  it.effect("keeps waiting while output arrives, past any fixed limit", () =>
    Effect.gen(function* () {
      // Ten and a half minutes of checkout, one progress line every 90 seconds.
      const fiber = yield* withGitStallTimeout(
        STALL_MS,
        (stall) => new Stalled(stall),
        (watch) =>
          Effect.gen(function* () {
            for (let percent = 0; percent <= 100; percent += 15) {
              yield* Effect.sleep("90 seconds");
              yield* watch.touch(`Updating files: ${percent}% (1/2)`);
            }
            return "checked out";
          }),
      ).pipe(Effect.forkChild);

      yield* TestClock.adjust("11 minutes");
      assert.equal(yield* Fiber.join(fiber), "checked out");
    }),
  );

  it.effect("fails after the stall window with elapsed time and the last output", () =>
    Effect.gen(function* () {
      const touched = yield* Deferred.make<void>();
      const fiber = yield* withGitStallTimeout(
        STALL_MS,
        (stall) => new Stalled(stall),
        (watch) =>
          Effect.gen(function* () {
            yield* Effect.sleep("30 seconds");
            yield* watch.touch("Updating files: 100% (29631/29631), done.");
            // Blank lines are output too, but keep the last meaningful one for the error.
            yield* watch.touch("   ");
            yield* Deferred.succeed(touched, undefined);
            return yield* Effect.never;
          }),
      ).pipe(Effect.forkChild);

      yield* TestClock.adjust("30 seconds");
      yield* Deferred.await(touched);
      yield* TestClock.adjust("119 seconds");
      assert.isUndefined(fiber.pollUnsafe());
      yield* TestClock.adjust("1 second");
      const exit = yield* Fiber.await(fiber);

      assert.isTrue(Exit.isFailure(exit));
      assert.deepStrictEqual(
        Option.getOrUndefined(Exit.findErrorOption(exit)),
        new Stalled({
          elapsedMs: 150_000,
          idleMs: 120_000,
          lastOutput: "Updating files: 100% (29631/29631), done.",
        }),
      );
    }),
  );

  it("describes the stall for the launch error", () => {
    assert.equal(
      describeGitStall({
        elapsedMs: 323_500,
        idleMs: 120_000,
        lastOutput: "Updating files: 100% (29631/29631), done.",
      }),
      "Git made no progress for 2m 0s and was stopped after 5m 24s. Last output: Updating files: 100% (29631/29631), done.",
    );
    assert.equal(
      describeGitStall({ elapsedMs: 120_000, idleMs: 120_000, lastOutput: null }),
      "Git made no progress for 2m 0s and was stopped after 2m 0s. It printed nothing.",
    );
  });
});
