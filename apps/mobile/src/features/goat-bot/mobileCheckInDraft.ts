import {
  CHECK_IN_DEFAULT_TIME,
  CHECK_IN_DEFAULT_WEEKDAYS,
} from "@goat/client-runtime/scheduledTasks";

/**
 * The check-in being set up and its save; the Home list keeps them, so they outlive the cell
 * scrolling away. `edits` counts changes and never goes back, Cancel included, so a save that
 * finishes knows whether it saved these. `pending` is the running save's request, which Cancel keeps.
 */
export interface MobileCheckInDraft {
  readonly open: boolean;
  readonly timeOfDay: string;
  readonly weekdays: readonly number[];
  readonly edits: number;
  readonly pending: number | null;
  readonly error: string | null;
}

export const MOBILE_CHECK_IN_DRAFT: MobileCheckInDraft = {
  open: false,
  timeOfDay: CHECK_IN_DEFAULT_TIME,
  weekdays: CHECK_IN_DEFAULT_WEEKDAYS,
  edits: 0,
  pending: null,
  error: null,
};

let lastCheckInRequest = 0;
/** A save's identity; never reused, so a late reply cannot settle a later save. */
export const nextCheckInRequest = () => ++lastCheckInRequest;

/** A closed draft that still counts its edits and keeps a save that is still running. */
export const closedCheckInDraft = (current: MobileCheckInDraft): MobileCheckInDraft => ({
  ...MOBILE_CHECK_IN_DRAFT,
  edits: current.edits + 1,
  pending: current.pending,
});

/** Changes the check-in from the latest state, so a late save never overwrites a newer edit. */
export type MobileCheckInDraftUpdate = (
  update: (draft: MobileCheckInDraft) => MobileCheckInDraft,
) => void;
