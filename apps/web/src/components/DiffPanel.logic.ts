import type { RunId } from "@goat/contracts";

import type { DiffPanelSourceItem } from "../diffPanelStore";

/**
 * Which checkpoint a turn selection shows. A run's checkpoint is captured when it ends, so a file
 * clicked during the latest run has no summary yet; showing another turn in its place would read
 * as that edit having no changes, and reconciling to it would keep the wrong turn once the
 * checkpoint arrives. Until then, an edit row's Open diff shows that edit's own patch.
 */
export function resolveDiffPanelTurn<T extends { readonly runId: RunId }>(input: {
  readonly orderedSummaries: ReadonlyArray<T>;
  readonly selectedRunId: RunId | null;
  readonly activeRunId: RunId | null | undefined;
  readonly latestRunId: RunId | null | undefined;
  readonly sourceItem: DiffPanelSourceItem | null;
}): {
  readonly turn: T | undefined;
  /** The selected run is the thread's latest and has no checkpoint summary yet. */
  readonly awaitingCheckpoint: boolean;
  readonly runActive: boolean;
  /** The edit whose own patch stands in for the missing checkpoint. */
  readonly edit: DiffPanelSourceItem | null;
} {
  const { orderedSummaries, selectedRunId } = input;
  const runActive = selectedRunId !== null && selectedRunId === input.activeRunId;
  if (selectedRunId === null) {
    return { turn: undefined, awaitingCheckpoint: false, runActive, edit: null };
  }
  const exact = orderedSummaries.find((summary) => summary.runId === selectedRunId);
  if (exact !== undefined) return { turn: exact, awaitingCheckpoint: false, runActive, edit: null };
  if (runActive || selectedRunId === input.latestRunId) {
    return { turn: undefined, awaitingCheckpoint: true, runActive, edit: input.sourceItem };
  }
  return { turn: orderedSummaries[0], awaitingCheckpoint: false, runActive, edit: null };
}
