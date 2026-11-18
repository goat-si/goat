import { readTimelinePosition, type RememberedTimelinePosition } from "./timelineScrollAnchoring";
import type { WorkGroupViewState } from "./timelineRowContext";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

export function keyExtractor(item: MessagesTimelineRow) {
  return item.id;
}

// LegendList averages by type; length buckets prevent inflated estimates and nested-update loops.
export function getItemType(item: MessagesTimelineRow) {
  if (item.kind !== "message") return item.kind;
  const lengthBucket = Math.max(0, Math.floor(Math.log2(item.message.text.length / 1000)));
  return `message:${item.message.role}:${lengthBucket}`;
}

export function timelineListStateFor(identity: string): {
  readonly identity: string;
  readonly rememberedPosition: RememberedTimelinePosition | undefined;
  readonly workGroupViewState: WorkGroupViewState;
} {
  const rememberedPosition = readTimelinePosition(identity);
  return {
    identity,
    rememberedPosition,
    workGroupViewState: rememberedPosition?.disclosures?.workGroupState ?? {
      scrollPositions: new Map(),
      expandedEntries: new Set(),
    },
  };
}
