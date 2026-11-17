import * as Schema from "effect/Schema";

import { CommandId, IsoDateTime, MessageId, ThreadId } from "./baseSchemas.ts";
import { OrchestrationV2Notification } from "./orchestrationV2Notification.ts";
import { ThreadPullRequestKey, ThreadPullRequestWatch } from "./threadPullRequest.ts";

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
  ...ThreadPullRequestKey.fields,
  startedAt: IsoDateTime,
  watch: Schema.NullOr(ThreadPullRequestWatch),
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
});
