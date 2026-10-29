import type { EnvironmentId, RunId, ScopedThreadRef } from "@goat/contracts";
import { useEffect } from "react";

import {
  type DiffPanelSelection,
  resolveToolCallDiffTarget,
  useDiffPanelStore,
} from "../../diffPanelStore";
import { useQuietThreadVisibleTurnItems } from "../../state/entities";
import { useTurnItemDetail } from "../../state/queries";
import { resolveDiffPanelTurn } from "../DiffPanel.logic";

const emptyStateClassName =
  "flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70";

/**
 * The turn a diff panel selection shows, or the selected tool call's own patch. The patch comes
 * from the same cached query as the edit row's inline diff and takes the shape of a checkpoint
 * diff. Checkpoint diffs hide whitespace on the server; the edit's patch arrives raw, so it carries
 * the setting for the panel's parser.
 */
export function useDiffPanelTurn<T extends { readonly runId: RunId }>(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly selection: DiffPanelSelection;
  readonly orderedSummaries: ReadonlyArray<T>;
  readonly environmentId: EnvironmentId | undefined;
  readonly ignoreWhitespace: boolean;
  readonly activeRunId: RunId | null | undefined;
  readonly latestRunId: RunId | null | undefined;
}) {
  const { threadRef, selection, orderedSummaries, environmentId } = input;
  const rest = resolveDiffPanelTurn({
    orderedSummaries,
    selectedRunId: selection.kind === "turn" ? selection.turnId : null,
    activeRunId: input.activeRunId,
    latestRunId: input.latestRunId,
  });
  const { awaitingCheckpoint } = rest;
  const toolCall = selection.kind === "tool-call" ? selection : null;
  const visibleItems = useQuietThreadVisibleTurnItems(toolCall ? threadRef : null);
  const source = toolCall ? resolveToolCallDiffTarget(toolCall, visibleItems) : null;

  useEffect(() => {
    if (!threadRef || selection.kind !== "turn" || awaitingCheckpoint) return;
    useDiffPanelStore.getState().reconcileTurnSelection(
      threadRef,
      orderedSummaries.map((summary) => summary.runId),
    );
  }, [awaitingCheckpoint, selection, orderedSummaries, threadRef]);

  const detail = useTurnItemDetail(
    source && environmentId
      ? {
          environmentId,
          threadId: source.threadId,
          itemId: source.itemId,
          revision: source.revision,
        }
      : null,
  );
  const item = detail.data?.item;
  const diff = item?.type === "file_change" ? item.patch : undefined;
  const edit =
    source === null
      ? null
      : {
          data: diff === undefined ? null : { diff },
          error: detail.error,
          isPending: detail.isPending,
          sectionId: `edit:${source.itemId}`,
          ignoreWhitespace: input.ignoreWhitespace,
        };
  return { ...rest, edit };
}

export function DiffPanelAwaitingCheckpoint({ runActive }: { readonly runActive: boolean }) {
  return (
    <div className={emptyStateClassName}>
      {runActive
        ? "This turn's changes appear here when it finishes."
        : "No checkpoint for this turn yet."}
    </div>
  );
}
