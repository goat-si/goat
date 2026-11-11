import {
  CHECK_IN_DEFAULT_TIME,
  CHECK_IN_DEFAULT_WEEKDAYS,
} from "@goat/client-runtime/scheduledTasks";

/**
 * The check-in being set up and its save; the Home list keeps them, so they outlive the cell
 * scrolling away. `edits` counts changes, so a save that finishes knows whether it saved these.
 */
export interface MobileCheckInDraft {
  readonly open: boolean;
  readonly timeOfDay: string;
  readonly weekdays: readonly number[];
  readonly edits: number;
  readonly saving: boolean;
  readonly error: string | null;
}

export const MOBILE_CHECK_IN_DRAFT: MobileCheckInDraft = {
  open: false,
  timeOfDay: CHECK_IN_DEFAULT_TIME,
  weekdays: CHECK_IN_DEFAULT_WEEKDAYS,
  edits: 0,
  saving: false,
  error: null,
};

/** Changes the check-in from the latest state, so a late save never overwrites a newer edit. */
export type MobileCheckInDraftUpdate = (
  update: (draft: MobileCheckInDraft) => MobileCheckInDraft,
) => void;
