import type {
  OrchestrationV2Command,
  OrchestrationV2ConversationMessage,
  OrchestrationV2DomainEvent,
  OrchestrationV2Notification,
  OrchestrationV2ThreadProjection,
} from "@goat/contracts";
import type * as DateTime from "effect/DateTime";
import { queuedRunsInDeliveryOrder } from "./QueuedRunOrder.ts";

import { LAUNCH_WATCH_MESSAGE_PREFIX } from "../mcp/launchWatch.ts";
import { HOST_PRESSURE_MESSAGE_PREFIX } from "../fleet/pressure/pressureModel.ts";
import {
  framePendingReports,
  REMOTE_NOTICE_MESSAGE_PREFIXES,
} from "../remoteReports/reportFrame.ts";

/**
 * Notices that wait for a busy thread fold into one queued turn instead of one turn each. A
 * notice is a server wake from a producer below; each producer owns its message-id prefix, so
 * the lane (which thread or host a notice is about) comes from the id it already writes.
 */
export interface Notice {
  readonly id: string;
  readonly text: string;
}

/** An inbox report with the launched thread it came from, when the inbox knows it. */
export interface InboxReport {
  readonly host: string | null;
  readonly threadId: string | null;
  readonly kind: string;
  readonly text: string;
}

const reportLane = (report: InboxReport) =>
  report.threadId === null ? null : threadLane(report.host, report.threadId);

const segments = (id: string, prefix: string) => id.slice(prefix.length).split(":");

/** The lane a notice is about, or null when no notice producer wrote the id. */
export function noticeLane(id: string): string | null {
  if (id.startsWith(LAUNCH_WATCH_MESSAGE_PREFIX)) {
    // launcher:host:thread, each URI-encoded, so none of them contains a colon.
    const [, host = "", thread = ""] = segments(id, LAUNCH_WATCH_MESSAGE_PREFIX);
    return threadLane(decodeURIComponent(host) || null, decodeURIComponent(thread));
  }
  if (id.startsWith(HOST_PRESSURE_MESSAGE_PREFIX))
    return `host:${segments(id, HOST_PRESSURE_MESSAGE_PREFIX)[0]}`;
  const remote = REMOTE_NOTICE_MESSAGE_PREFIXES.find((prefix) => id.startsWith(prefix));
  return remote === undefined ? null : `report:${segments(id, remote)[0]}`;
}

/** The lane key for a launched thread, shared by run-end notices and inbox reports. */
export const threadLane = (host: string | null, threadId: string) =>
  `thread:${host ?? ""}/${threadId}`;

const isRunEnd = (id: string) =>
  id.startsWith(LAUNCH_WATCH_MESSAGE_PREFIX) &&
  segments(id, LAUNCH_WATCH_MESSAGE_PREFIX).slice(3).join(":").startsWith("run:");

const OPEN = "<notice id=";
const CLOSE = "</notice>";
// Notice text can quote remote data; it must not be able to end its own block.
const escapeBody = (text: string) => text.replaceAll(CLOSE, "<\\/notice>");
const unescapeBody = (text: string) => text.replaceAll("<\\/notice>", CLOSE);

function render(notices: ReadonlyArray<Notice>): string {
  return [
    `<notices count="${notices.length}">`,
    ...notices.map(
      (notice) => `${OPEN}${JSON.stringify(notice.id)}>\n${escapeBody(notice.text)}\n${CLOSE}`,
    ),
    "</notices>",
  ].join("\n");
}

/** The notices a message holds: one, or the blocks of a digest this module wrote. */
export function parseNotices(id: string, text: string): ReadonlyArray<Notice> {
  if (!text.startsWith("<notices count=")) return [{ id, text }];
  const notices: Notice[] = [];
  for (const block of text.split(`\n${OPEN}`).slice(1)) {
    const end = block.indexOf(">\n");
    const bodyEnd = block.lastIndexOf(`\n${CLOSE}`);
    if (end === -1 || bodyEnd === -1) continue;
    notices.push({
      id: JSON.parse(block.slice(0, end)) as string,
      text: unescapeBody(block.slice(end + 2, bodyEnd)),
    });
  }
  return notices;
}

/**
 * Adds a notice to a queued digest. Notices about the same lane stay together, lanes keep the
 * order they first arrived in, and a host's newer pressure notice replaces its older one.
 */
export function foldNotice(
  existing: ReadonlyArray<Notice>,
  incoming: Notice,
): ReadonlyArray<Notice> {
  const lane = noticeLane(incoming.id);
  const kept =
    lane?.startsWith("host:") === true
      ? existing.filter((notice) => noticeLane(notice.id) !== lane)
      : existing;
  const order = [
    ...new Set([...kept, incoming].map((notice) => noticeLane(notice.id) ?? notice.id)),
  ];
  return order.flatMap((key) =>
    [...kept, incoming].filter((notice) => (noticeLane(notice.id) ?? notice.id) === key),
  );
}

export function renderNotices(notices: ReadonlyArray<Notice>): string {
  const [only] = notices;
  return notices.length === 1 && only !== undefined ? only.text : render(notices);
}

/** The summary a client shows for a digest: how many notices, and the newest. */
export function foldedNotification(
  count: number,
  newest: OrchestrationV2Notification,
): OrchestrationV2Notification {
  return { ...newest, summary: `${count} notices · ${newest.summary}`.slice(0, 160) };
}

/**
 * The text a turn starts with: inbox reports grouped by lane, then the message. When a lane's
 * terminal report is in the inbox, that lane's run-end notice shrinks to its first line, so the
 * result arrives once.
 */
export function turnText(
  message: { readonly messageId: string; readonly text: string },
  inbox: ReadonlyArray<InboxReport>,
): string {
  if (inbox.length === 0) return message.text;
  const reported = new Set(
    inbox
      .filter((report) => report.kind === "completed" || report.kind === "failed")
      .flatMap((report) => reportLane(report) ?? []),
  );
  let shortened = false;
  const notices = parseNotices(message.messageId, message.text).map((notice) => {
    if (!isRunEnd(notice.id) || !reported.has(noticeLane(notice.id) ?? "")) return notice;
    shortened = true;
    return { ...notice, text: notice.text.split("\n", 1)[0] ?? notice.text };
  });
  const lanes = [...new Set(inbox.map(reportLane))];
  const reports = lanes.flatMap((lane) =>
    inbox.filter((report) => reportLane(report) === lane).map((report) => report.text),
  );
  return `${framePendingReports(reports)}\n\n${shortened ? renderNotices(notices) : message.text}`;
}

type Dispatch = Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>;

const isNoticeMessage = (message: {
  readonly id: string;
  readonly createdBy: string;
  readonly creationSource: string;
  readonly notification?: OrchestrationV2Notification | undefined;
}) =>
  message.createdBy === "agent" &&
  message.creationSource === "server" &&
  message.notification !== undefined &&
  noticeLane(message.id) !== null;

/**
 * The event that folds a queued notice into the notice turn already waiting at the end of the
 * queue, or undefined when it should queue its own turn. Only a notice behind a notice folds,
 * so a user message keeps its place, and a notice never waits behind one sent after it.
 */
export function foldIntoQueuedNotice(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">,
  command: Dispatch,
  now: DateTime.Utc,
):
  | Omit<Extract<OrchestrationV2DomainEvent, { readonly type: "message.updated" }>, "id">
  | undefined {
  if (
    command.notification === undefined ||
    command.dispatchMode.type !== "queue_after_active" ||
    command.dispatchMode.behindRunId !== undefined ||
    command.delegatedCompletion !== undefined ||
    command.attachments.length > 0 ||
    !isNoticeMessage({ ...command, id: command.messageId })
  )
    return undefined;
  const target = queuedRunsInDeliveryOrder(projection).at(-1);
  const queued: OrchestrationV2ConversationMessage | undefined = projection.messages.find(
    (message) => message.id === target?.userMessageId,
  );
  if (target === undefined || queued === undefined || !isNoticeMessage(queued)) return undefined;
  const notices = foldNotice(parseNotices(queued.id, queued.text), {
    id: command.messageId,
    text: command.text,
  });
  return {
    type: "message.updated",
    threadId: command.threadId,
    runId: target.id,
    ...(target.rootNodeId === null ? {} : { nodeId: target.rootNodeId }),
    providerInstanceId: target.providerInstanceId,
    occurredAt: now,
    payload: {
      ...queued,
      text: renderNotices(notices),
      notification: foldedNotification(notices.length, command.notification),
      updatedAt: now,
    },
  };
}
