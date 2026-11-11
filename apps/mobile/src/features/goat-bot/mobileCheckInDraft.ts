import {
  CHECK_IN_DEFAULT_TIME,
  CHECK_IN_DEFAULT_WEEKDAYS,
} from "@goat/client-runtime/scheduledTasks";

/** The check-in being set up; the Home list keeps it, so it outlives its cell scrolling away. */
export interface MobileCheckInDraft {
  readonly open: boolean;
  readonly timeOfDay: string;
  readonly weekdays: readonly number[];
}

export const MOBILE_CHECK_IN_DRAFT: MobileCheckInDraft = {
  open: false,
  timeOfDay: CHECK_IN_DEFAULT_TIME,
  weekdays: CHECK_IN_DEFAULT_WEEKDAYS,
};
