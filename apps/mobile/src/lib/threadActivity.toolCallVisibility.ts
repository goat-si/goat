import {
  liveThoughtLine,
  workEntryHiddenByToolCallVisibility,
} from "@goat/client-runtime/work-log/presentation";
import type { MessageId, RunId } from "@goat/contracts";
import type { ToolCallVisibility } from "@goat/contracts/settings";

import type {
  ThreadFeedActivity,
  ThreadFeedActivityGroup,
  ThreadFeedEntry,
  ThreadFeedMessage,
} from "./threadActivity";
import { compactWorkEntryText } from "./workEntryRowLabel";

export interface ThreadFeedDisplay {
  readonly toolCallVisibility: ToolCallVisibility;
  readonly revealedMessageId: MessageId | null;
}

export const DEFAULT_THREAD_FEED_DISPLAY: ThreadFeedDisplay = {
  toolCallVisibility: "showAll",
  revealedMessageId: null,
};

const visibleActivityGroups = new WeakMap<
  ThreadFeedActivityGroup,
  { readonly visibility: ToolCallVisibility; readonly group: ThreadFeedActivityGroup | null }
>();

function zenKeepsActivity(activity: ThreadFeedActivity): boolean {
  const item = activity.projectedItem.item;
  return (
    activity.prominent ||
    activity.workEntry.questionAnswer !== undefined ||
    item.type === "compaction" ||
    item.type === "handoff" ||
    item.type === "notification" ||
    (item.type === "error" && item.status !== "completed")
  );
}

/** The group with the activities this visibility shows, or null when it shows none. */
export function activityGroupForVisibility(
  entry: ThreadFeedActivityGroup,
  visibility: ToolCallVisibility,
): ThreadFeedActivityGroup | null {
  const cached = visibleActivityGroups.get(entry);
  if (cached?.visibility === visibility) return cached.group;
  const activities = entry.activities.filter((activity) =>
    visibility === "zen"
      ? zenKeepsActivity(activity)
      : !workEntryHiddenByToolCallVisibility(activity.workEntry, visibility),
  );
  const group =
    activities.length === 0
      ? null
      : activities.length === entry.activities.length
        ? entry
        : { ...entry, activities };
  visibleActivityGroups.set(entry, { visibility, group });
  return group;
}

function isSteerMessage(message: ThreadFeedMessage): boolean {
  return (
    message.role === "user" &&
    (message.inputIntent === "steer" || message.inputIntent === "promoted_queued_to_steer")
  );
}

function startsResponse(entry: ThreadFeedEntry): boolean {
  return (
    (entry.type === "message" && entry.message.role === "user" && !isSteerMessage(entry.message)) ||
    (entry.type === "activity-group" &&
      entry.activities.some((activity) => activity.projectedItem.item.type === "notification"))
  );
}

/** The assistant messages zen shows: each response's last reply, and answers to a steer. */
export function zenAnswerMessageIds(
  feed: ReadonlyArray<ThreadFeedEntry>,
  start: number,
  answering: boolean,
  answeringRunId: RunId | null,
): ReadonlySet<MessageId> {
  const replies: Array<{ readonly message: ThreadFeedMessage; readonly index: number }> = [];
  const lastReplyByResponse = new Map<string, MessageId>();
  const steerAnswers = new Set<MessageId>();
  let userMessages = 0;
  let awaitingReply = false;
  let candidate: MessageId | null = null;
  let answeringFrom = answering ? start : feed.length;
  for (let index = start; index < feed.length; index += 1) {
    const entry = feed[index];
    if (entry === undefined) continue;
    if (
      entry.type === "activity-group" &&
      entry.activities.every((activity) => activity.workEntry.itemType === "reasoning")
    ) {
      continue;
    }
    const reply =
      entry.type === "message" && entry.message.role === "assistant" ? entry.message : null;
    if (candidate !== null && reply !== null) steerAnswers.add(candidate);
    candidate = null;
    if (answering && startsResponse(entry)) answeringFrom = index + 1;
    if (entry.type === "message" && entry.message.role === "user") {
      userMessages += 1;
      awaitingReply = isSteerMessage(entry.message);
    } else if (reply !== null) {
      replies.push({ message: reply, index });
      lastReplyByResponse.set(reply.runId ?? `runless:${userMessages}`, reply.id);
      if (awaitingReply) {
        candidate = reply.id;
        awaitingReply = false;
      }
    }
  }
  const terminal = new Set(lastReplyByResponse.values());
  return new Set(
    replies
      .filter(
        ({ message, index }) =>
          steerAnswers.has(message.id) ||
          (terminal.has(message.id) &&
            index < answeringFrom &&
            (answeringRunId === null || message.runId !== answeringRunId)),
      )
      .map(({ message }) => message.id),
  );
}

/** In zen, the live row reads the latest line the agent wrote or thought in the open response. */
export function liveAnswerPreview(feed: ReadonlyArray<ThreadFeedEntry>): string | null {
  for (let index = feed.length - 1; index >= 0; index -= 1) {
    const entry = feed[index];
    if (entry === undefined) continue;
    if (startsResponse(entry)) return null;
    const texts =
      entry.type === "message"
        ? entry.message.role === "assistant"
          ? [entry.message.text]
          : []
        : entry.type === "activity-group"
          ? entry.activities
              .filter((activity) => activity.workEntry.itemType === "reasoning")
              .map((activity) => activity.workEntry.detail ?? "")
          : [];
    for (let textIndex = texts.length - 1; textIndex >= 0; textIndex -= 1) {
      const line = compactWorkEntryText(liveThoughtLine(texts[textIndex] ?? ""));
      if (line !== "") return line;
    }
  }
  return null;
}
