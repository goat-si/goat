/**
 * Pull request watch news in the between-turn digest (#1055). A wake is a notice like any other,
 * so one queued behind a busy turn folds into the waiting digest. What a watch keeps as context
 * waits on the watch, one fragment per kind, and the next notice turn to start carries it as one
 * line per pull request; the same write clears it, so it is told once. Dropping a pull request's
 * wakes removes its notices from queued digests and keeps the rest (#926, #1056).
 *
 * @module PullRequestDigest
 */
import {
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Notification,
  type OrchestrationV2Run,
  type RunId,
  type ThreadId,
  type ThreadPullRequestKey,
  type ThreadPullRequestWatch,
  TurnItemId,
} from "@goat/contracts";
import {
  normalizeThreadPullRequestKey,
  threadPullRequestKeysEqual,
  threadPullRequestsOf,
} from "@goat/shared/threadPullRequests";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import {
  heldContextLine,
  mergeHeldContext,
  settleHeldContext,
  withHeldContext,
} from "../pullRequestWatch.ts";
import { foldNotice, isNoticeMessage, parseNotices, renderDigest } from "../TurnDigest.ts";
import {
  pullRequestHeldNoticeId,
  pullRequestWakeChecksHead,
  pullRequestWakePrefix,
} from "./PullRequestWatchWakes.ts";

type DigestEvent = Omit<
  Extract<
    OrchestrationV2DomainEvent,
    { readonly type: "message.updated" | "thread.pull-request-link-updated" }
  >,
  "id"
>;

/**
 * The text a notice turn starts with once the thread's kept pull request context joins it, and
 * the events that record it: the watches cleared and, for a message already stored under `run`,
 * the message itself. Undefined when the message is not a notice or nothing is kept.
 */
export function takeHeldPullRequestContext(input: {
  readonly thread: Pick<OrchestrationV2AppThread, "id" | "providerInstanceId" | "pullRequests">;
  readonly message: Pick<
    OrchestrationV2ConversationMessage,
    "id" | "text" | "createdBy" | "creationSource" | "notification"
  >;
  readonly now: DateTime.Utc;
  readonly stored?: {
    readonly message: OrchestrationV2ConversationMessage;
    readonly run: OrchestrationV2Run;
  };
}): { readonly text: string; readonly events: ReadonlyArray<DigestEvent> } | undefined {
  const { thread, message, now } = input;
  if (!isNoticeMessage(message)) return undefined;
  const kept = (thread.pullRequests ?? []).flatMap((link) => {
    if (link.watch === undefined) return [];
    const { heldContext = [], ...watch } = link.watch;
    return link.source === "stack-dismissed" || heldContext.length === 0
      ? []
      : [{ link, heldContext, cleared: { ...link, watch } }];
  });
  if (kept.length === 0) return undefined;
  const notices = kept.reduce(
    (digest, { link, heldContext }) =>
      foldNotice(digest, {
        id: pullRequestHeldNoticeId(link),
        text: heldContextLine(link, mergeHeldContext(heldContext)),
      }),
    parseNotices(message.id, message.text),
  );
  const text = renderDigest(message.id, notices);
  const cleared = kept.map(({ cleared: payload }): DigestEvent => ({
    type: "thread.pull-request-link-updated",
    threadId: thread.id,
    providerInstanceId: thread.providerInstanceId,
    occurredAt: now,
    payload,
  }));
  const { stored } = input;
  return {
    text,
    events:
      stored === undefined
        ? cleared
        : [
            ...cleared,
            {
              type: "message.updated",
              threadId: thread.id,
              runId: stored.run.id,
              ...(stored.run.rootNodeId === null ? {} : { nodeId: stored.run.rootNodeId }),
              providerInstanceId: stored.run.providerInstanceId,
              occurredAt: now,
              payload: { ...stored.message, text, updatedAt: now },
            },
          ],
  };
}

/**
 * Removes a pull request's wakes from the turns still queued: every one when its watch stopped or
 * its pull request merged or closed, or, given its new head, only the check results of other
 * heads. A queued turn left with nothing is cancelled; a digest keeps its other notices.
 */
export const dropQueuedPullRequestWakes = Effect.fn("PullRequestDigest.dropQueuedWakes")(function* <
  E,
  R,
  E2,
  R2,
  E3,
  R3,
>(
  key: ThreadPullRequestKey,
  records: Effect.Effect<
    {
      readonly thread: Parameters<typeof threadPullRequestsOf>[0];
      readonly runs: ReadonlyArray<OrchestrationV2Run>;
    },
    E,
    R
  >,
  messageOf: (
    runId: RunId,
  ) => Effect.Effect<OrchestrationV2ConversationMessage | undefined, E2, R2>,
  write: (
    change: { readonly cancel: RunId } | { readonly update: DigestEvent },
  ) => Effect.Effect<void, E3, R3>,
  headSha?: string,
) {
  const { thread, runs } = yield* records;
  const normalized = normalizeThreadPullRequestKey(key);
  // The stored link carries the url the reactor named the wake from.
  const link =
    threadPullRequestsOf(thread).find((candidate) =>
      threadPullRequestKeysEqual(candidate, normalized),
    ) ?? normalized;
  const prefix = pullRequestWakePrefix(link);
  const stale = (id: string) => {
    if (!id.startsWith(prefix)) return false;
    if (headSha === undefined) return true;
    const ranOn = pullRequestWakeChecksHead(id, prefix);
    return ranOn !== null && ranOn !== headSha;
  };
  for (const run of runs) {
    if (run.status !== "queued") continue;
    const message = yield* messageOf(run.id);
    if (message === undefined) continue;
    const notices = parseNotices(message.id, message.text);
    const kept = notices.filter((notice) => !stale(notice.id));
    if (kept.length === notices.length) continue;
    if (kept.length === 0) {
      yield* write({ cancel: run.id });
      continue;
    }
    const now = yield* DateTime.now;
    yield* write({
      update: {
        type: "message.updated",
        threadId: run.threadId,
        runId: run.id,
        ...(run.rootNodeId === null ? {} : { nodeId: run.rootNodeId }),
        providerInstanceId: run.providerInstanceId,
        occurredAt: now,
        payload: {
          ...message,
          text: renderDigest(message.id, kept),
          ...(message.notification === undefined
            ? {}
            : {
                notification: {
                  ...message.notification,
                  summary: `${kept.length} ${kept.length === 1 ? "notice" : "notices"}`,
                },
              }),
          updatedAt: now,
        },
      },
    });
  }
});

/** The timeline item an update kept as context leaves; it is for the user and starts no turn. */
export const pullRequestWatchNote = (
  command: { readonly commandId: string; readonly threadId: ThreadId },
  note: OrchestrationV2Notification,
  ordinal: number,
  now: DateTime.Utc,
): Omit<Extract<OrchestrationV2DomainEvent, { readonly type: "turn-item.updated" }>, "id"> => ({
  type: "turn-item.updated",
  threadId: command.threadId,
  occurredAt: now,
  payload: {
    id: TurnItemId.make(`turn-item:pr-watch:${command.commandId}`),
    threadId: command.threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed",
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    type: "notification",
    ...note,
  },
});

/**
 * The text of the wake a watch ends on, with what the watch still kept. It is read under the
 * thread lock: a notice turn that started while the host was read has already told the rest. A
 * watch ending on its comment limit carries the pass's own kept fragments on `ended`; they merge
 * with the stored ones after those settle against the pass's state, in the same write.
 */
export const endingWakeText = (
  text: string,
  watch: ThreadPullRequestWatch,
  ended: ThreadPullRequestWatch | undefined,
) =>
  withHeldContext(
    text,
    ended === undefined
      ? mergeHeldContext(watch.heldContext)
      : mergeHeldContext(
          settleHeldContext(watch.heldContext, {
            ...ended,
            headMoved: ended.headSha !== watch.headSha,
          }),
          ended.heldContext,
        ),
  );
