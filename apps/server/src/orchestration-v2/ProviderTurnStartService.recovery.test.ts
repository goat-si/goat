import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { makeLocalCommandHarness } from "./ProviderTurnStartService.localCommand.testkit.ts";

it.effect("fails a starting run when its recovery state cannot be read", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      recoveryReadFailure: "stored turn item no longer decodes",
    });
    yield* harness.start.pipe(Effect.ignore);
    expect(harness.open).not.toHaveBeenCalled();
    expect(harness.startRootRun).not.toHaveBeenCalled();
    const projection = harness.projection();
    expect(projection.runs.at(-1)).toMatchObject({ status: "failed", startedAt: null });
    expect(projection.attempts[0]).toMatchObject({ status: "failed", startedAt: null });
    expect(projection.nodes[0]).toMatchObject({ status: "failed", startedAt: null });
    expect(projection.turnItems).toMatchObject([{ type: "error", status: "failed" }]);
  }),
);
