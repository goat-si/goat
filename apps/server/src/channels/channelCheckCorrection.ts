/**
 * A GOAT check that was pending or running when a task's outcome was told, and later ended
 * without running, is corrected once. Only the writer knows the earlier state, so it commits that
 * observation under an id derived from the task and run; the narrator tells exactly that event.
 *
 * @module channelCheckCorrection
 */
import type { ChannelTask, ChannelTaskEventId, ChannelWorkerResult } from "@goat/contracts";
import * as Effect from "effect/Effect";

import type * as ChannelLedger from "./ChannelLedger.ts";
import { checkNotRunEventIdFor } from "./channelIds.ts";

const unresolved = (result: ChannelWorkerResult) =>
  result.observedCheckPending === true || result.observedCheck?.status === "running";

const endedNotRun = (result: ChannelWorkerResult | undefined) =>
  result !== undefined &&
  result.observedCheckPending === false &&
  result.observedCheck === undefined;

/**
 * The id a writer commits this observation under: the correction id when it ends an unresolved
 * check of the same run without a run and no correction was committed for that run yet.
 */
export const checkCorrectionEventId = Effect.fn("channelCheckCorrection.eventId")(function* (
  ledger: ChannelLedger.ChannelLedger["Service"],
  task: ChannelTask,
  next: ChannelWorkerResult | undefined,
) {
  const previous = task.observed?.result;
  if (previous === undefined || next === undefined || previous.runId !== next.runId)
    return undefined;
  if (!unresolved(previous) || !endedNotRun(next)) return undefined;
  const eventId = checkNotRunEventIdFor(task.taskId, next.runId);
  return (yield* ledger.hasTaskEvent(eventId)) ? undefined : eventId;
});

/** Whether this event is the correction for the run its result names. */
export const isCheckCorrection = (
  task: ChannelTask,
  eventId: ChannelTaskEventId,
  result: ChannelWorkerResult,
) => eventId === checkNotRunEventIdFor(task.taskId, result.runId);

/**
 * Whether the task's current result is a correction still to be told. The outcome then leaves
 * its verification sentence to that correction, so the person reads it once. Read after the task,
 * so a correction committed before that read is always seen.
 */
export const correctionTellsEvidence = (
  ledger: ChannelLedger.ChannelLedger["Service"],
  task: ChannelTask,
) => {
  const result = task.observed?.result;
  return result === undefined || !endedNotRun(result)
    ? Effect.succeed(false)
    : ledger.hasTaskEvent(checkNotRunEventIdFor(task.taskId, result.runId));
};
