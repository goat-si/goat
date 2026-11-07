import type { ThreadFeedEntry } from "../../lib/threadActivity";
import { EXPANDABLE_ROW_MIN_HEIGHT } from "./work-log-layout";

// Content-driven rows must be measured by LegendList: returning a fixed size
// makes the list skip native measurement entirely.
const TURN_FOLD_HEIGHT = EXPANDABLE_ROW_MIN_HEIGHT + 3.5;
const WORK_GROUP_TOGGLE_HEIGHT = EXPANDABLE_ROW_MIN_HEIGHT;

export function resolveThreadFeedFixedItemSize(
  entryType: ThreadFeedEntry["type"],
): number | undefined {
  switch (entryType) {
    case "run-fold":
      return TURN_FOLD_HEIGHT;
    case "work-toggle":
      return WORK_GROUP_TOGGLE_HEIGHT;
    case "activity-group":
    case "message":
      return undefined;
  }
}
