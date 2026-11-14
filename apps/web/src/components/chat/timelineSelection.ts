import { useEffect, useState } from "react";

export function selectedTimelineRowIds(viewport: Element): string[] {
  const selection = document.getSelection();
  const range =
    selection && !selection.isCollapsed && selection.rangeCount > 0
      ? selection.getRangeAt(0)
      : null;
  const next: string[] = [];
  if (range?.intersectsNode(viewport)) {
    for (const row of viewport.querySelectorAll<HTMLElement>("[data-timeline-row-id]")) {
      const rowId = row.dataset.timelineRowId;
      if (rowId && range.intersectsNode(row)) next.push(rowId);
    }
  }
  return next;
}

// Rows between the selected ones are covered too, even if not mounted right now.
export function timelineRowSpanIndices(
  rows: ReadonlyArray<{ id: string }>,
  rowIds: ReadonlyArray<string>,
): number[] {
  if (rowIds.length === 0) return [];
  const selected = new Set(rowIds);
  const first = rows.findIndex((row) => selected.has(row.id));
  const last = rows.findLastIndex((row) => selected.has(row.id));
  if (first < 0) return [];
  return Array.from({ length: last - first + 1 }, (_, i) => first + i);
}

// LegendList recycles a row's container once it leaves the draw buffer, which
// moves a native selection's ends onto other rows. Pin the selected rows.
export function useSelectedTimelineRowIndices(
  viewport: HTMLElement | null,
  rows: ReadonlyArray<{ id: string }>,
  restoring: ReadonlyArray<number> | undefined,
) {
  const [rowIds, setRowIds] = useState<ReadonlyArray<string>>([]);
  // oxlint-disable-next-line goat/react-effect-budget -- subscribe to document selection changes for the current viewport
  useEffect(() => {
    if (!viewport) return;
    const update = () => {
      const next = selectedTimelineRowIds(viewport);
      setRowIds((current) =>
        current.length === next.length && current.every((id, i) => id === next[i]) ? current : next,
      );
    };
    document.addEventListener("selectionchange", update);
    return () => {
      document.removeEventListener("selectionchange", update);
      setRowIds([]);
    };
  }, [viewport]);
  return [...(restoring ?? []), ...timelineRowSpanIndices(rows, rowIds)];
}
