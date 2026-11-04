import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";

import { STOPPED_EARLIER_TURN_MESSAGE } from "./goat/StoppedEarlierTurn.ts";
import { makeLocalCommandHarness } from "./ProviderTurnStartService.localCommand.testkit.ts";

const notices = (harness: ReturnType<typeof makeLocalCommandHarness>) =>
  harness.projection().turnItems.filter((item) => item.type === "system_notice");

// A completed run whose turn Codex kept running is the H2 case: its start used to queue a second turn.
effectIt.effect.each([
  { runStatus: "failed", notice: true },
  { runStatus: "completed", notice: true },
  { runStatus: "interrupted", terminationCause: "agent_stop", notice: true },
  { runStatus: "interrupted", terminationCause: "person_stop", notice: false },
] as const)("stops a turn an ended run left running before continuing: %j", (ended) =>
  Effect.gen(function* () {
    const { notice, ...previous } = ended;
    const harness = makeLocalCommandHarness({
      text: "Continue",
      previousTurn: { ...previous, turnStatus: "running" },
    });

    yield* harness.start;

    expect(harness.interruptTurn).toHaveBeenCalledOnce();
    expect(harness.projection().providerTurns[0]).toMatchObject({ status: "interrupted" });
    expect(notices(harness)).toMatchObject(
      notice ? [{ runId: harness.runId, message: STOPPED_EARLIER_TURN_MESSAGE }] : [],
    );
    expect(harness.startRootRun).toHaveBeenCalledOnce();
  }),
);

effectIt.effect("shows no stopped-turn notice when no live session stopped the turn", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      previousTurn: { runStatus: "failed", turnStatus: "running", liveSession: false },
    });

    yield* harness.start;

    expect(harness.interruptTurn).not.toHaveBeenCalled();
    expect(notices(harness)).toEqual([]);
  }),
);
