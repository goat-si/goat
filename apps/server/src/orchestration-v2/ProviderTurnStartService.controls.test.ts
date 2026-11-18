import { it as effectIt } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { makeLocalCommandHarness } from "./ProviderTurnStartService.localCommand.testkit.ts";

effectIt.effect("recovers an abandoned failed turn before continuing its native conversation", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      previousTurn: { runStatus: "failed", turnStatus: "running" },
    });

    yield* harness.start;

    expect(harness.interruptTurn).toHaveBeenCalledOnce();
    expect(harness.projection().runs.at(-1)?.status).toBe("running");
    expect(harness.projection().providerTurns[0]).toMatchObject({
      status: "interrupted",
      completedAt: expect.anything(),
    });
    expect(harness.startRootRun).toHaveBeenCalledOnce();
    expect(harness.startRootRun.mock.calls[0]?.[0].providerThread.nativeThreadRef?.nativeId).toBe(
      "existing-native-conversation",
    );
  }),
);

effectIt.effect("hands the run worker the reason its Stop recorded, read for that run only", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      previousTurn: { runStatus: "failed", turnStatus: "running" },
    });
    yield* harness.start;
    const started = harness.startRootRun.mock.calls[0]![0];
    harness.setProjection({
      ...harness.projection(),
      turnItems: [
        {
          type: "run_interrupt_request",
          runId: harness.runId,
          message: "Stopped by an agent: done",
        },
      ],
    } as never);

    // Without it a late interrupted terminal records the Stop as the user's.
    expect(yield* started.loadRunInterruptReason!()).toBe("Stopped by an agent: done");
    expect(harness.getThreadRecords).toHaveBeenLastCalledWith(harness.threadId, ["turnItems"], {
      turnItemTypes: ["run_interrupt_request"],
      turnItemRunIds: [harness.runId],
    });
  }),
);
