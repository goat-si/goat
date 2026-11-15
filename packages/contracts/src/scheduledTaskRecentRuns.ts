import * as Schema from "effect/Schema";

import { CommandId, IsoDateTime, ThreadId } from "./baseSchemas.ts";
import { ChannelInputId } from "./channelCommon.ts";

/**
 * Firings a GOAT Bot routine keeps, in flight or finished, and the most its list entry carries. A
 * firing still in flight is never deleted, so more can stay stored while they run; the list
 * carries the newest of them.
 */
export const SCHEDULED_TASK_RECENT_RUNS = 7;
/** GOAT Bot routines whose history one list carries, newest created first; the rest carry none. */
export const SCHEDULED_TASK_RECENT_RUN_ROUTINES = 50;
/** Encoded bytes of history one list carries; the routines past it carry none, in list order. */
export const SCHEDULED_TASK_RECENT_RUN_BYTES = 128 * 1024;

/** One recent firing of a GOAT Bot routine, for its row's history. */
export const ScheduledTaskRecentRun = Schema.Struct({
  firingId: CommandId,
  /** A ScheduledTaskRun status, or any later one; clients show unknown ones as unknown. */
  status: Schema.String,
  requestedAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
  /** Where the run spoke in GOAT Bot's chat; absent when the bot never received it. */
  conversation: Schema.optionalKey(Schema.Struct({ threadId: ThreadId, inputId: ChannelInputId })),
  /** The bot answered that nothing needed the person: no reply was posted. */
  quiet: Schema.optionalKey(Schema.Literal(true)),
  /** The run never reached the bot. Set from the stored dispatch outcome, apart from conversation. */
  dispatchFailed: Schema.optionalKey(Schema.Literal(true)),
});
export type ScheduledTaskRecentRun = typeof ScheduledTaskRecentRun.Type;
