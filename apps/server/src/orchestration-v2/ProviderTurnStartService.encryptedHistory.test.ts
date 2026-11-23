import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";
import { makeLocalCommandHarness } from "./ProviderTurnStartService.localCommand.testkit.ts";

it.effect("does not replace rejected Codex history while its background work is still active", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      previousTurn: { runStatus: "failed", turnStatus: "completed", supersededTurn: true },
      rejectedHistoryWithPendingWork: true,
    });
    const projection = harness.projection();
    const acceptedAttempt = projection.providerTurns[0]?.runAttemptId;
    if (acceptedAttempt == null) return yield* Effect.die("missing accepted attempt");
    harness.setProjection({
      ...projection,
      runs: projection.runs.map((run, index) =>
        index === 0 ? { ...run, activeAttemptId: acceptedAttempt } : run,
      ),
    });
    yield* harness.start;
    expect(harness.projection().runs.at(-1)?.status).toBe("failed");
    expect(harness.startRootRun).not.toHaveBeenCalled();
    expect(harness.projection().turnItems.at(-1)).toMatchObject({
      type: "error",
      title: "Provider turn failed to start",
    });
  }),
);
