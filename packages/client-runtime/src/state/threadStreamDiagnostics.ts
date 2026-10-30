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

export type ThreadStreamStart =
  | "http snapshot"
  | "socket snapshot"
  | "replay"
  | "up to date"
  | "live events";

export interface ThreadStreamTransition {
  readonly at: number;
  readonly what: string;
}

/** The newest assistant reply as the socket delivered it, the client state holds it, and the feed drew it. */
export interface ThreadStreamReply {
  readonly messageId: string;
  readonly receivedLength: number;
  readonly receivedAt: number;
  readonly appliedLength: number | null;
  readonly drawnLength: number | null;
  readonly drawnAt: number | null;
}

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
  readonly unknownEvents: number;
  readonly lastSequence: number | null;
  readonly lastEventAt: number | null;
  readonly lastEventType: string | null;
  readonly reply: ThreadStreamReply | null;
  readonly transitions: ReadonlyArray<ThreadStreamTransition>;
}

type MutableDiagnostic = {
  -readonly [Key in keyof ThreadStreamDiagnostic]: ThreadStreamDiagnostic[Key];
} & {
  transitions: ThreadStreamTransition[];
  awaitingFirstItem: boolean;
  replaying: boolean;
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
    unknownEvents: 0,
    lastSequence: null,
    lastEventAt: null,
    lastEventType: null,
    reply: null,
    transitions: [],
    awaitingFirstItem: false,
    replaying: false,
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
  record.replaying = input.completionMarker;
  transition(
    record,
    input.afterSequence === null ? "subscribe" : `subscribe after #${input.afterSequence}`,
  );
  notify();
}

export function noteThreadStreamSnapshot(
  environmentId: string,
  threadId: string,
  input: { readonly sequence: number; readonly source: "http" | "socket" },
): void {
  const record = recordFor(environmentId, threadId);
  record.snapshots += 1;
  record.lastSequence = input.sequence;
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
  record.replaying = false;
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
    readonly reply: Omit<ThreadStreamReply, "receivedAt" | "drawnLength" | "drawnAt"> | null;
    readonly status: string;
    readonly hasError: boolean;
  },
): void {
  const record = recordFor(environmentId, threadId);
  const count = input.known + input.unknown;
  if (record.replaying) record.replayedEvents += count;
  else record.liveEvents += count;
  record.unknownEvents += input.unknown;
  record.lastSequence = input.sequence;
  record.lastEventAt = clock();
  if (input.eventType !== null) record.lastEventType = input.eventType;
  if (input.reply !== null) {
    const sameReply = record.reply?.messageId === input.reply.messageId;
    record.reply = {
      ...input.reply,
      receivedAt: clock(),
      drawnLength: sameReply ? (record.reply?.drawnLength ?? null) : null,
      drawnAt: sameReply ? (record.reply?.drawnAt ?? null) : null,
    };
  }
  if (record.awaitingFirstItem) {
    record.awaitingFirstItem = false;
    record.lastStart = record.replaying ? "replay" : "live events";
  }
  if (record.status !== input.status || record.hasError !== input.hasError) {
    record.status = input.status;
    record.hasError = input.hasError;
    transition(record, input.hasError ? `${input.status} with error` : input.status);
  }
  if (listeners.size > 0) notify();
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

/** A feed row drew this reply; only the newest received reply is tracked. */
export function noteThreadFeedReplyDrawn(
  environmentId: string,
  threadId: string,
  messageId: string,
  length: number,
): void {
  const record = records.get(keyOf(environmentId, threadId));
  if (record?.reply?.messageId !== messageId || record.reply.drawnLength === length) return;
  record.reply = { ...record.reply, drawnLength: length, drawnAt: clock() };
  if (listeners.size > 0) notify();
}

type EventItem = Extract<OrchestrationV2ThreadStreamItem, { kind: "event" }>;

/** The newest assistant reply in a batch, as delivered and as the reducer now holds it. */
export function replyProgress(
  events: ReadonlyArray<EventItem>,
  projection: OrchestrationV2ThreadProjection | null,
): Omit<ThreadStreamReply, "receivedAt" | "drawnLength" | "drawnAt"> | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]?.event;
    if (event?.type !== "turn-item.updated" || event.payload.type !== "assistant_message") continue;
    const item = event.payload;
    let appliedLength: number | null = null;
    const rows = projection?.visibleTurnItems ?? [];
    for (let row = rows.length - 1; row >= 0; row -= 1) {
      const candidate = rows[row]?.item;
      if (candidate?.id !== item.id) continue;
      appliedLength = candidate.type === "assistant_message" ? candidate.text.length : null;
      break;
    }
    return { messageId: item.messageId, receivedLength: item.text.length, appliedLength };
  }
  return null;
}

export function readThreadStreamDiagnostics(): ReadonlyArray<ThreadStreamDiagnostic> {
  return [...records.values()]
    .map(({ awaitingFirstItem: _a, replaying: _r, pendingStart: _p, ...record }) => ({
      ...record,
      transitions: [...record.transitions],
    }))
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

function formatReply(reply: ThreadStreamReply | null): string {
  if (reply === null) return "  latest reply: none received while open";
  return [
    `  latest reply ${reply.messageId}: received ${reply.receivedLength} chars at ${formatTime(reply.receivedAt)}`,
    `in state ${reply.appliedLength ?? "missing"}`,
    `drawn ${reply.drawnLength ?? "not yet"}${reply.drawnAt === null ? "" : ` at ${formatTime(reply.drawnAt)}`}`,
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
        `  events: ${d.replayedEvents} replayed, ${d.liveEvents} live, ${d.unknownEvents} unknown; last #${d.lastSequence ?? "-"} ${d.lastEventType ?? ""} at ${formatTime(d.lastEventAt)}`,
        `  snapshots: ${d.snapshots}`,
        formatReply(d.reply),
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
