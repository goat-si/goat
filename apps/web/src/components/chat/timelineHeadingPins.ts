import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

export function timelineHeadingPins(rows: ReadonlyArray<MessagesTimelineRow>) {
  const hasHeading = (row: MessagesTimelineRow) =>
    row.kind === "message" && row.message.role !== "system";
  const first = rows.find(hasHeading);
  const last = rows.findLast(hasHeading);
  return [...(first ? [first.id] : []), ...(last && last !== first ? [last.id] : [])];
}
