import { RunId, ThreadId, TurnItemId } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveDiffPanelTurn } from "./DiffPanel.logic";

const previous = { runId: RunId.make("run-previous"), checkpointTurnCount: 1 };
const current = { runId: RunId.make("run-current"), checkpointTurnCount: 2 };
const clickedEdit = {
  threadId: ThreadId.make("thread-1"),
  itemId: TurnItemId.make("item-edit"),
  revision: "2026-10-24T10:00:00.000Z",
};

describe("resolveDiffPanelTurn", () => {
  it("waits for the clicked run's checkpoint instead of showing an older turn", () => {
    // An edit row clicked while its run is still working: only the previous turn has a checkpoint.
    expect(
      resolveDiffPanelTurn({
        orderedSummaries: [previous],
        selectedRunId: current.runId,
        activeRunId: current.runId,
        latestRunId: current.runId,
        sourceItem: null,
      }),
    ).toEqual({ turn: undefined, awaitingCheckpoint: true, runActive: true, edit: null });
  });

  it("regression #1397: shows the clicked edit's own patch while its run has no checkpoint", () => {
    expect(
      resolveDiffPanelTurn({
        orderedSummaries: [previous],
        selectedRunId: current.runId,
        activeRunId: current.runId,
        latestRunId: current.runId,
        sourceItem: clickedEdit,
      }),
    ).toEqual({ turn: undefined, awaitingCheckpoint: true, runActive: true, edit: clickedEdit });
  });

  it("shows a finished turn's checkpoint even when it was opened from an edit row", () => {
    expect(
      resolveDiffPanelTurn({
        orderedSummaries: [current, previous],
        selectedRunId: current.runId,
        activeRunId: null,
        latestRunId: current.runId,
        sourceItem: clickedEdit,
      }),
    ).toEqual({ turn: current, awaitingCheckpoint: false, runActive: false, edit: null });
  });

  it("keeps a finished latest run selected while its checkpoint is captured", () => {
    expect(
      resolveDiffPanelTurn({
        orderedSummaries: [previous],
        selectedRunId: current.runId,
        activeRunId: null,
        latestRunId: current.runId,
        sourceItem: null,
      }),
    ).toEqual({ turn: undefined, awaitingCheckpoint: true, runActive: false, edit: null });
  });

  it("shows the clicked run once its checkpoint arrives", () => {
    expect(
      resolveDiffPanelTurn({
        orderedSummaries: [current, previous],
        selectedRunId: current.runId,
        activeRunId: null,
        latestRunId: current.runId,
        sourceItem: null,
      }),
    ).toEqual({ turn: current, awaitingCheckpoint: false, runActive: false, edit: null });
  });

  it("falls back to the latest turn when the selected run no longer exists", () => {
    expect(
      resolveDiffPanelTurn({
        orderedSummaries: [current, previous],
        selectedRunId: RunId.make("run-reverted"),
        activeRunId: null,
        latestRunId: current.runId,
        sourceItem: null,
      }),
    ).toEqual({ turn: current, awaitingCheckpoint: false, runActive: false, edit: null });
  });
});
