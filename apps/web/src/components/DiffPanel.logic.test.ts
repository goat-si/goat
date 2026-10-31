import { RunId } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveDiffPanelTurn, selectVisibleDiffFiles } from "./DiffPanel.logic";
import { getRenderablePatch, resolveFileDiffPath } from "../lib/diffRendering";

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

describe("diff panel test-file filtering", () => {
  it.each([
    ["/repo/src/foo.test.ts", "/repo"],
    ["C:\\repo\\src\\foo.test.ts", "C:\\repo"],
    ["./src/foo.test.ts", undefined],
    ["/repo/src/old.test.ts", "/repo"],
  ])(
    "keeps the requested test file visible for %s while preserving its full-list index",
    (selectedPath, cwd) => {
      const parsed = getRenderablePatch(
        [
          "diff --git a/src/hidden.test.ts b/src/hidden.test.ts",
          "--- a/src/hidden.test.ts",
          "+++ b/src/hidden.test.ts",
          "@@ -1 +1 @@",
          "-a",
          "+b",
          "diff --git a/src/old.test.ts b/src/foo.test.ts",
          "similarity index 90%",
          "rename from src/old.test.ts",
          "rename to src/foo.test.ts",
          "--- a/src/old.test.ts",
          "+++ b/src/foo.test.ts",
          "@@ -1 +1 @@",
          "-a",
          "+b",
          "diff --git a/src/app.ts b/src/app.ts",
          "--- a/src/app.ts",
          "+++ b/src/app.ts",
          "@@ -1 +1 @@",
          "-a",
          "+b",
        ].join("\n"),
        "requested-test",
      );
      expect(parsed?.kind).toBe("files");
      if (parsed?.kind !== "files") throw new Error("Expected parsed files");
      const result = selectVisibleDiffFiles(parsed.files, selectedPath, cwd, true);
      expect(result.visibleFiles.map(resolveFileDiffPath)).toEqual([
        "src/foo.test.ts",
        "src/app.ts",
      ]);
      expect(parsed.files.indexOf(result.selectedPatchFile!)).toBe(1);
    },
  );
});
