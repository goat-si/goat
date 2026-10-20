import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  PositiveInt,
  RuntimeRequestId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { PullRequestState } from "./pullRequest.ts";

/**
 * What the channel ledger last saw in a task's worker thread besides its run status. A task keeps
 * its status (running or waiting_input) while these change, so a person can tell "working",
 * "blocked on me" and "waiting for a usage reset" apart without the status lying about it.
 */

/** A pull request the worker thread opened or linked, copied from the thread's own links. */
export const ChannelTaskPullRequest = Schema.Struct({
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  url: TrimmedNonEmptyString,
  /** Absent until the host has been read once. */
  state: Schema.optional(PullRequestState),
  /** The server watches the pull request and wakes the worker on checks, comments or conflicts. */
  watching: Schema.Boolean,
});
export type ChannelTaskPullRequest = typeof ChannelTaskPullRequest.Type;

/**
 * Something only a person can unblock inside the worker thread: a question the provider asked
 * natively, a tool approval, a provider sign-in, or a usage limit nothing will resume on its own
 * (no known reset, or automatic resume turned off). Questions asked with channel_task_report are
 * open questions on the task instead.
 */
export const ChannelTaskNeedsYouKind = Schema.Literals([
  "question",
  "approval",
  "sign_in",
  "usage_limit",
]);
export type ChannelTaskNeedsYouKind = typeof ChannelTaskNeedsYouKind.Type;

/**
 * The exact approval a person can answer from GOAT Bot: the request and the thread that holds it
 * (the worker or one of its subagents). `host`, when set, is the machine whose GOAT holds the
 * request; absent means this machine.
 */
export const ChannelTaskApprovalRef = Schema.Struct({
  requestId: RuntimeRequestId,
  threadId: ThreadId,
  host: Schema.optional(TrimmedNonEmptyString),
});
export type ChannelTaskApprovalRef = typeof ChannelTaskApprovalRef.Type;

export const ChannelTaskNeedsYou = Schema.Struct({
  kind: ChannelTaskNeedsYouKind,
  since: IsoDateTime,
  approval: Schema.optional(ChannelTaskApprovalRef),
});
export type ChannelTaskNeedsYou = typeof ChannelTaskNeedsYou.Type;

export const ChannelWorkerObservation = Schema.Struct({
  pullRequests: Schema.Array(ChannelTaskPullRequest),
  needsYou: Schema.Array(ChannelTaskNeedsYou),
  /** The worker stopped on a provider usage limit and continues after this time. */
  usageLimitResetAt: Schema.optional(IsoDateTime),
});
export type ChannelWorkerObservation = typeof ChannelWorkerObservation.Type;

export const EMPTY_CHANNEL_WORKER_OBSERVATION: ChannelWorkerObservation = {
  pullRequests: [],
  needsYou: [],
};

/** Whether two observations would show the same thing; equal ones are not written again. */
export const channelWorkerObservationEquals = (
  left: ChannelWorkerObservation | undefined,
  right: ChannelWorkerObservation | undefined,
): boolean => {
  const a = left ?? EMPTY_CHANNEL_WORKER_OBSERVATION;
  const b = right ?? EMPTY_CHANNEL_WORKER_OBSERVATION;
  return (
    a.usageLimitResetAt === b.usageLimitResetAt &&
    a.needsYou.length === b.needsYou.length &&
    a.needsYou.every(
      (item, index) =>
        item.kind === b.needsYou[index]?.kind &&
        item.since === b.needsYou[index]?.since &&
        item.approval?.requestId === b.needsYou[index]?.approval?.requestId &&
        item.approval?.threadId === b.needsYou[index]?.approval?.threadId &&
        item.approval?.host === b.needsYou[index]?.approval?.host,
    ) &&
    a.pullRequests.length === b.pullRequests.length &&
    a.pullRequests.every((item, index) => {
      const other = b.pullRequests[index];
      return (
        other !== undefined &&
        item.repository === other.repository &&
        item.number === other.number &&
        item.url === other.url &&
        item.state === other.state &&
        item.watching === other.watching
      );
    })
  );
};
