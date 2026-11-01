import type {
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadStreamItem,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";

/**
 * In-memory diagnostics for live thread streams, read by a client's Diagnostics screen.
 *
 * Nothing here leaves the device, and nothing records message content: only ids, counts, text
 * lengths and times. An applied event batch costs one Map lookup and a few field writes;
 * listeners exist only while a screen shows the data.
 */

const MAX_THREADS = 20;
const MAX_TRANSITIONS = 12;
const MAX_ROWS = 8;
// A streaming reply is among the newest rows; a deeper miss is reported as missing, not searched.
const REPLY_LOOKUP_ROWS = 64;

export type ThreadStreamStart =
  | "http snapshot"
  | "socket snapshot"
  | "replay"
  | "up to date"
  | "live events"
  | "events, replay or live unclear";

/** Without a completion marker a resumed subscription cannot tell replay from the live tail. */
type EventPhase = "replay" | "live" | "unclear";

export interface ThreadStreamTransition {
  readonly at: number;
  readonly what: string;
}

/**
 * The newest assistant reply as the stream delivered it, as the client state holds it, and as the
 * feed row last committed it. A committed row can be offscreen, so its visibility is kept too.
 */
export interface ThreadStreamReply {
  readonly messageId: string;
  /** Where and when the body behind receivedLength arrived; a deduplicated update moves neither. */
  readonly receivedVia: ReplySource | null;
  readonly receivedLength: number | null;
  readonly receivedAt: number | null;
  readonly appliedLength: number | null;
  readonly updatedVia: ReplySource;
  readonly updatedAt: number;
}

type ReplySource = "event" | "http snapshot" | "socket snapshot";

/** The last time a feed row committed a reply, kept apart from which reply is selected. */
export interface ThreadFeedReplyRow {
  readonly length: number;
  readonly visible: boolean;
  readonly committedAt: number;
  readonly unmountedAt: number | null;
}

type ReceivedReply = Pick<ThreadStreamReply, "messageId" | "receivedLength" | "appliedLength">;

export interface ThreadStreamDiagnostic {
  readonly environmentId: string;
  readonly threadId: string;
  readonly openedAt: number;
  readonly closedAt: number | null;
  readonly status: string;
  readonly hasError: boolean;
  readonly subscriptions: number;
  readonly lastSubscribedAt: number | null;
  readonly lastStart: ThreadStreamStart | null;
  readonly snapshots: number;
  readonly replayedEvents: number;
  readonly liveEvents: number;
  readonly unclearEvents: number;
  readonly unknownEvents: number;
  readonly lastSequence: number | null;
  readonly lastEventAt: number | null;
  readonly lastEventType: string | null;
  readonly reply: ThreadStreamReply | null;
  /** "dropped" when the row's observation was evicted, or may have been once eviction history overflowed. */
  readonly replyRow: ThreadFeedReplyRow | "dropped" | null;
  readonly transitions: ReadonlyArray<ThreadStreamTransition>;
}

type MutableDiagnostic = {
  -readonly [Key in keyof ThreadStreamDiagnostic]: ThreadStreamDiagnostic[Key];
} & {
  transitions: ThreadStreamTransition[];
  rows: Map<string, ThreadFeedReplyRow>;
  evictedRows: Set<string>;
  /** Some eviction history was itself dropped, so an unknown row may have been committed. */
  evictionsForgotten: boolean;
  awaitingFirstItem: boolean;
  phase: EventPhase;
  pendingStart: ThreadStreamStart | null;
};

const records = new Map<string, MutableDiagnostic>();
const listeners = new Set<() => void>();
let version = 0;
let clock: () => number = Date.now;

function keyOf(environmentId: string, threadId: string): string {
  return `${environmentId}\u0000${threadId}`;
}

function notify(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function freshRecord(environmentId: string, threadId: string): MutableDiagnostic {
  return {
    environmentId,
    threadId,
    openedAt: clock(),
    closedAt: null,
    status: "opening",
    hasError: false,
    subscriptions: 0,
    lastSubscribedAt: null,
    lastStart: null,
    snapshots: 0,
    replayedEvents: 0,
    liveEvents: 0,
    unclearEvents: 0,
    unknownEvents: 0,
    lastSequence: null,
    lastEventAt: null,
    lastEventType: null,
    reply: null,
    replyRow: null,
    transitions: [],
    rows: new Map(),
    evictedRows: new Set(),
    evictionsForgotten: false,
    awaitingFirstItem: false,
    phase: "live",
    pendingStart: null,
  };
}

function recordFor(environmentId: string, threadId: string): MutableDiagnostic {
  const key = keyOf(environmentId, threadId);
  let record = records.get(key);
  if (record === undefined) {
    record = freshRecord(environmentId, threadId);
    records.set(key, record);
    while (records.size > MAX_THREADS) {
      const oldest = records.keys().next().value;
      if (oldest === undefined) break;
      records.delete(oldest);
    }
  }
  return record;
}

function transition(record: MutableDiagnostic, what: string): void {
  record.transitions.push({ at: clock(), what });
  if (record.transitions.length > MAX_TRANSITIONS) record.transitions.shift();
}

/** A closed thread opened again starts over, as the most recent entry. */
export function noteThreadStreamOpened(environmentId: string, threadId: string): void {
  const key = keyOf(environmentId, threadId);
  if (records.get(key)?.closedAt != null) records.delete(key);
  transition(recordFor(environmentId, threadId), "opened");
  notify();
}

export function noteThreadStreamClosed(environmentId: string, threadId: string): void {
  const record = records.get(keyOf(environmentId, threadId));
  if (record === undefined) return;
  record.closedAt = clock();
  transition(record, "closed");
  notify();
}

/** One subscription attempt. With a completion marker, events before it are replay. */
export function noteThreadStreamSubscribed(
  environmentId: string,
  threadId: string,
  input: { readonly afterSequence: number | null; readonly completionMarker: boolean },
): void {
  const record = recordFor(environmentId, threadId);
  record.subscriptions += 1;
  record.lastSubscribedAt = clock();
  record.lastStart = record.pendingStart;
  record.awaitingFirstItem = record.pendingStart === null;
  record.pendingStart = null;
  record.phase = input.completionMarker
    ? "replay"
    : input.afterSequence === null
      ? "live"
      : "unclear";
  transition(
    record,
    input.afterSequence === null ? "subscribe" : `subscribe after #${input.afterSequence}`,
  );
  notify();
}

export function noteThreadStreamSnapshot(
  environmentId: string,
  threadId: string,
  input: {
    readonly sequence: number;
    readonly source: "http" | "socket";
    readonly reply: ReceivedReply | null;
  },
): void {
  const record = recordFor(environmentId, threadId);
  record.snapshots += 1;
  record.lastSequence = input.sequence;
  if (input.reply !== null) setReply(record, input.reply, `${input.source} snapshot`);
  else if (record.reply !== null) {
    // The snapshot replaced the state and holds no reply, so the tracked one is gone from it.
    record.reply = {
      ...record.reply,
      appliedLength: null,
      updatedVia: `${input.source} snapshot`,
      updatedAt: clock(),
    };
  }
  if (input.source === "http") {
    // The HTTP snapshot loads before the socket subscribes, so it starts the next attempt.
    record.pendingStart = "http snapshot";
  } else if (record.awaitingFirstItem) {
    record.awaitingFirstItem = false;
    record.lastStart = "socket snapshot";
  }
  transition(record, `${input.source} snapshot #${input.sequence}`);
  notify();
}

export function noteThreadStreamSynchronized(environmentId: string, threadId: string): void {
  const record = recordFor(environmentId, threadId);
  if (record.awaitingFirstItem) {
    record.awaitingFirstItem = false;
    record.lastStart = "up to date";
  }
  record.phase = "live";
  transition(record, "synchronized");
  notify();
}

export function noteThreadStreamEvents(
  environmentId: string,
  threadId: string,
  input: {
    readonly known: number;
    readonly unknown: number;
    readonly sequence: number;
    readonly eventType: string | null;
    readonly reply: ReceivedReply | null;
    readonly status: string;
    readonly hasError: boolean;
  },
): void {
  const record = recordFor(environmentId, threadId);
  const count = input.known + input.unknown;
  if (record.phase === "replay") record.replayedEvents += count;
  else if (record.phase === "live") record.liveEvents += count;
  else record.unclearEvents += count;
  record.unknownEvents += input.unknown;
  record.lastSequence = input.sequence;
  record.lastEventAt = clock();
  if (input.eventType !== null) record.lastEventType = input.eventType;
  if (input.reply !== null) setReply(record, input.reply, "event");
  if (record.awaitingFirstItem) {
    record.awaitingFirstItem = false;
    record.lastStart =
      record.phase === "replay"
        ? "replay"
        : record.phase === "live"
          ? "live events"
          : "events, replay or live unclear";
  }
  if (record.status !== input.status || record.hasError !== input.hasError) {
    record.status = input.status;
    record.hasError = input.hasError;
    transition(record, input.hasError ? `${input.status} with error` : input.status);
  }
  notify();
}

export function noteThreadStreamStatus(
  environmentId: string,
  threadId: string,
  status: string,
  hasError: boolean,
): void {
  const record = recordFor(environmentId, threadId);
  if (record.status === status && record.hasError === hasError) return;
  record.status = status;
  record.hasError = hasError;
  transition(record, hasError ? `${status} with error` : status);
  notify();
}

function setReply(record: MutableDiagnostic, reply: ReceivedReply, via: ReplySource): void {
  const previous = record.reply?.messageId === reply.messageId ? record.reply : null;
  const now = clock();
  // A deduplicated body arrives empty and refers to text received earlier.
  const body =
    reply.receivedLength === null
      ? {
          receivedVia: previous?.receivedVia ?? null,
          receivedLength: previous?.receivedLength ?? null,
          receivedAt: previous?.receivedAt ?? null,
        }
      : { receivedVia: via, receivedLength: reply.receivedLength, receivedAt: now };
  record.reply = {
    messageId: reply.messageId,
    ...body,
    appliedLength: reply.appliedLength,
    updatedVia: via,
    updatedAt: now,
  };
}

/** A feed row committed (or, with null, unmounted) a reply. Any reply's row is kept. */
export function noteThreadFeedReplyRow(
  environmentId: string,
  threadId: string,
  messageId: string,
  row: { readonly length: number; readonly visible: boolean } | null,
): void {
  const record = records.get(keyOf(environmentId, threadId));
  if (record === undefined) return;
  const previous = record.rows.get(messageId);
  if (row === null) {
    if (previous === undefined) return;
    record.rows.set(messageId, { ...previous, unmountedAt: clock() });
  } else {
    if (
      previous?.length === row.length &&
      previous.visible === row.visible &&
      previous.unmountedAt === null
    )
      return;
    record.rows.delete(messageId);
    record.evictedRows.delete(messageId);
    record.rows.set(messageId, { ...row, committedAt: clock(), unmountedAt: null });
    // The selected reply's row is never dropped; others are, oldest first, and remembered as dropped.
    for (const id of record.rows.keys()) {
      if (record.rows.size <= MAX_ROWS) break;
      if (id === record.reply?.messageId) continue;
      record.rows.delete(id);
      record.evictedRows.add(id);
      if (record.evictedRows.size > MAX_ROWS * 2) {
        const oldest = record.evictedRows.values().next().value;
        if (oldest !== undefined) record.evictedRows.delete(oldest);
        record.evictionsForgotten = true;
      }
    }
  }
  notify();
}

type EventItem = Extract<OrchestrationV2ThreadStreamItem, { kind: "event" }>;

function appliedReplyLength(
  projection: OrchestrationV2ThreadProjection | null,
  messageId: string,
): number | null {
  const rows = projection?.visibleTurnItems ?? [];
  const stop = Math.max(0, rows.length - REPLY_LOOKUP_ROWS);
  for (let index = rows.length - 1; index >= stop; index -= 1) {
    const item = rows[index]?.item;
    if (item?.type === "assistant_message" && item.messageId === messageId) return item.text.length;
  }
  return null;
}

/**
 * The newest assistant reply in a batch, with the body length that arrived for it (null when only
 * a deduplicated body arrived) and the length the reducer now holds.
 */
export function replyProgress(
  events: ReadonlyArray<EventItem>,
  projection: OrchestrationV2ThreadProjection | null,
): ReceivedReply | null {
  let messageId: string | null = null;
  let receivedLength: number | null = null;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]?.event;
    let id: string | null = null;
    let length: number | null = null;
    if (event?.type === "message.updated" && event.payload.role === "assistant") {
      id = event.payload.id;
      length = event.payload.text.length;
    } else if (event?.type === "turn-item.updated" && event.payload.type === "assistant_message") {
      id = event.payload.messageId;
      length = event.payload.textOmitted === true ? null : event.payload.text.length;
    }
    if (id === null || (messageId !== null && id !== messageId)) continue;
    messageId = id;
    if (length !== null) {
      receivedLength = length;
      break;
    }
  }
  if (messageId === null) return null;
  return { messageId, receivedLength, appliedLength: appliedReplyLength(projection, messageId) };
}

/** The newest assistant reply a snapshot carried, which arrives whole. */
export function snapshotReply(projection: OrchestrationV2ThreadProjection): ReceivedReply | null {
  const rows = projection.visibleTurnItems;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const item = rows[index]?.item;
    if (item?.type !== "assistant_message") continue;
    return {
      messageId: item.messageId,
      receivedLength: item.text.length,
      appliedLength: item.text.length,
    };
  }
  return null;
}

export function readThreadStreamDiagnostics(): ReadonlyArray<ThreadStreamDiagnostic> {
  return [...records.values()]
    .map(
      ({
        awaitingFirstItem: _a,
        phase: _r,
        pendingStart: _p,
        rows,
        evictedRows,
        evictionsForgotten,
        ...record
      }) => {
        const id = record.reply?.messageId;
        const diagnostic: ThreadStreamDiagnostic = {
          ...record,
          replyRow:
            id === undefined
              ? null
              : (rows.get(id) ?? (evictedRows.has(id) || evictionsForgotten ? "dropped" : null)),
          transitions: [...record.transitions],
        };
        return diagnostic;
      },
    )
    .reverse();
}

export function subscribeThreadStreamDiagnostics(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Changes whenever a subscribed reader should read the diagnostics again. */
export function threadStreamDiagnosticsVersion(): number {
  return version;
}

function formatTime(at: number | null): string {
  return at === null ? "never" : `${DateTime.formatIso(DateTime.makeUnsafe(at)).slice(11, 19)} UTC`;
}

function formatReply(
  reply: ThreadStreamReply | null,
  row: ThreadFeedReplyRow | "dropped" | null,
): string {
  if (reply === null) return "  latest reply: none received while open";
  const rowText =
    row === null
      ? "row not committed while open"
      : row === "dropped"
        ? "row observation no longer kept (it may have been committed earlier)"
        : `row committed ${row.length} at ${formatTime(row.committedAt)}, ${row.visible ? "on screen" : "offscreen"}${row.unmountedAt === null ? "" : `, unmounted at ${formatTime(row.unmountedAt)}`}`;
  return [
    `  latest reply ${reply.messageId}: received ${reply.receivedLength ?? "unknown"} chars via ${reply.receivedVia ?? "unknown"} at ${formatTime(reply.receivedAt)}`,
    `last updated via ${reply.updatedVia} at ${formatTime(reply.updatedAt)}`,
    `in state ${reply.appliedLength ?? "missing from the newest rows"}`,
    rowText,
  ].join(", ");
}

export function formatThreadStreamReport(
  diagnostics: ReadonlyArray<ThreadStreamDiagnostic>,
): string {
  if (diagnostics.length === 0) return "No thread streams opened since the app started.";
  return diagnostics
    .map((d) =>
      [
        `Thread ${d.threadId} (environment ${d.environmentId})${d.closedAt === null ? "" : `, closed ${formatTime(d.closedAt)}`}`,
        `  status: ${d.status}${d.hasError ? " with error" : ""}`,
        `  subscriptions: ${d.subscriptions}, last ${formatTime(d.lastSubscribedAt)}, started by ${d.lastStart ?? "nothing yet"}`,
        `  events: ${d.replayedEvents} replayed, ${d.liveEvents} live, ${d.unclearEvents} unclear, ${d.unknownEvents} unknown types; last #${d.lastSequence ?? "-"} ${d.lastEventType ?? ""} at ${formatTime(d.lastEventAt)}`,
        `  snapshots: ${d.snapshots}`,
        formatReply(d.reply, d.replyRow),
        `  recent: ${d.transitions.map((t) => `${t.what} ${formatTime(t.at)}`).join(", ")}`,
      ].join("\n"),
    )
    .join("\n\n");
}

/** Tests replace the clock and start from an empty store. */
export function resetThreadStreamDiagnosticsForTest(now: () => number = Date.now): void {
  records.clear();
  listeners.clear();
  clock = now;
}
