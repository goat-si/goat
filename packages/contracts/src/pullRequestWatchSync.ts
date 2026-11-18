import * as Schema from "effect/Schema";

import { CommandId, IsoDateTime, MessageId, ThreadId } from "./baseSchemas.ts";
import { OrchestrationV2Notification } from "./orchestrationV2Notification.ts";
import { ThreadPullRequestKey, ThreadPullRequestWatch } from "./threadPullRequest.ts";

const watchSyncFields = {
  ...ThreadPullRequestKey.fields,
  startedAt: IsoDateTime,
  watch: Schema.NullOr(ThreadPullRequestWatch),
  /**
   * The watch's checksPending when this read started. A push that clears it during the read makes
   * the read's answer describe the old head, so the cleared answer stays.
   */
  checksPendingBefore: Schema.optional(Schema.Boolean),
  /** With `watch: null`, the state the ended watch keeps instead of its last saved one. */
  endedWatch: Schema.optional(ThreadPullRequestWatch),
  /** The pull request merged or closed: wakes this watch queued and that have not started are dropped. */
  dropQueuedWakes: Schema.optional(Schema.Literal(true)),
  wake: Schema.optional(
    Schema.Struct({
      messageId: MessageId,
      text: Schema.String,
      notification: OrchestrationV2Notification,
    }),
  ),
  note: Schema.optional(OrchestrationV2Notification),
};

/**
 * Records what a pull request watch saw, and wakes the agent in the same transaction when
 * `wake` is set, or adds `note` to the timeline without starting a turn. Rejected once the
 * watch started at `startedAt` has ended, and a wake is rejected on a settled or archived
 * thread, so a read that raced either changes nothing.
 */
export const ThreadPullRequestWatchSyncCommand = Schema.Struct({
  type: Schema.Literal("thread.pull-request-watch.sync"),
  commandId: CommandId,
  threadId: ThreadId,
  ...watchSyncFields,
  /**
   * More watches of this thread read in the same pass: every wake reaches the agent as one digest,
   * and the whole command is refused if any of them ended or was muted during the read.
   */
  others: Schema.optional(Schema.Array(Schema.Struct(watchSyncFields))),
});

/**
 * After a push, the thread's watches forget whether their checks were running, since the push can
 * start new ones. Applied to the watches as they are then, so no earlier read overwrites them.
 */
export const ThreadPullRequestWatchChecksReopenCommand = Schema.Struct({
  type: Schema.Literal("thread.pull-request-watch.checks-reopen"),
  commandId: CommandId,
  threadId: ThreadId,
});
