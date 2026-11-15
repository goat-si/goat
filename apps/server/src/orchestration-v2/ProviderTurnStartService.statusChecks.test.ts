import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";

import { makeLocalCommandHarness } from "./ProviderTurnStartService.localCommand.testkit.ts";

effectIt.effect("checks the run's status without loading the thread's history", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      previousTurn: { runStatus: "completed", turnStatus: "completed" },
    });

    yield* harness.start;

    const controls = harness.startRootRun.mock.calls[0]?.[0];
    expect(controls).toBeDefined();
    if (controls === undefined) return;
    expect(yield* controls.shouldStartProviderTurn!()).toBe(true);
    expect(yield* controls.shouldFinalizeRun!()).toBe(true);
    // Each check needs one run row; the recovery projection reads every run and open turn item.
    // The one read left is the start's inherited background items snapshot, not a status check.
    expect(
      harness.getRuntimeRecoveryProjection.mock.calls.length,
      "recovery projection reads beyond the inherited background items snapshot",
    ).toBe(1);
  }),
);
