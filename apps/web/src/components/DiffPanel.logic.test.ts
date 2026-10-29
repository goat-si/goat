import { RunId } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveDiffPanelTurn } from "./DiffPanel.logic";

const previous = { runId: RunId.make("run-previous"), checkpointTurnCount: 1 };
const current = { runId: RunId.make("run-current"), checkpointTurnCount: 2 };

describe("resolveDiffPanelTurn", () => {
  it("waits for the clicked run's checkpoint instead of showing an older turn", () => {
    // An edit row clicked while its run is still working: only the previous turn has a checkpoint.
    expect(
      resolveDiffPanelTurn({
        orderedSummaries: [previous],
        selectedRunId: current.runId,
        activeRunId: current.runId,
        latestRunId: current.runId,
      }),
    ).toEqual({ turn: undefined, awaitingCheckpoint: true, runActive: true });
  });

  it("keeps a finished latest run selected while its checkpoint is captured", () => {
    expect(
      resolveDiffPanelTurn({
        orderedSummaries: [previous],
        selectedRunId: current.runId,
        activeRunId: null,
        latestRunId: current.runId,
      }),
    ).toEqual({ turn: undefined, awaitingCheckpoint: true, runActive: false });
  });

  it("shows the clicked run once its checkpoint arrives", () => {
    expect(
      resolveDiffPanelTurn({
        orderedSummaries: [current, previous],
        selectedRunId: current.runId,
        activeRunId: null,
        latestRunId: current.runId,
      }),
    ).toEqual({ turn: current, awaitingCheckpoint: false, runActive: false });
  });

  it("falls back to the latest turn when the selected run no longer exists", () => {
    expect(
      resolveDiffPanelTurn({
        orderedSummaries: [current, previous],
        selectedRunId: RunId.make("run-reverted"),
        activeRunId: null,
        latestRunId: current.runId,
      }),
    ).toEqual({ turn: current, awaitingCheckpoint: false, runActive: false });
  });
});
