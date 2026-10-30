/**
 * In-memory diagnostics for live thread streams, read by a client's Diagnostics screen.
 *
 * Nothing here leaves the device. Each applied event costs one Map lookup and a few field writes;
 * listeners exist only while a screen shows the data, so nothing re-renders otherwise.
 */

const MAX_THREADS = 20;
const MAX_TRANSITIONS = 12;

export type ThreadStreamStart = "snapshot" | "replay";

export interface ThreadStreamTransition {
  readonly at: number;
  readonly what: string;
}

export interface ThreadStreamDiagnostic {
  readonly environmentId: string;
  readonly threadId: string;
  readonly openedAt: number;
  readonly closedAt: number | null;
  readonly status: string;
  readonly error: string | null;
  readonly subscriptions: number;
  readonly lastSubscribedAt: number | null;
  readonly lastStart: ThreadStreamStart | null;
  readonly snapshots: number;
  readonly events: number;
  readonly lastSequence: number | null;
  readonly lastEventAt: number | null;
  readonly lastEventType: string | null;
  readonly latestItemOrdinal: number | null;
  readonly visibleItems: number | null;
  readonly renderedRows: number | null;
  readonly renderedAt: number | null;
  readonly transitions: ReadonlyArray<ThreadStreamTransition>;
}

type MutableDiagnostic = {
  -readonly [Key in keyof ThreadStreamDiagnostic]: ThreadStreamDiagnostic[Key];
} & { transitions: ThreadStreamTransition[]; awaitingFirstItem: boolean };

const records = new Map<string, MutableDiagnostic>();
const listeners = new Set<() => void>();
let clock: () => number = Date.now;

function keyOf(environmentId: string, threadId: string): string {
  return `${environmentId}\u0000${threadId}`;
}

function notify(): void {
  for (const listener of listeners) listener();
}

function recordFor(environmentId: string, threadId: string): MutableDiagnostic {
  const key = keyOf(environmentId, threadId);
  let record = records.get(key);
  if (record === undefined) {
    record = {
      environmentId,
      threadId,
      openedAt: clock(),
      closedAt: null,
      status: "opening",
      error: null,
      subscriptions: 0,
      lastSubscribedAt: null,
      lastStart: null,
      snapshots: 0,
      events: 0,
      lastSequence: null,
      lastEventAt: null,
      lastEventType: null,
      latestItemOrdinal: null,
      visibleItems: null,
      renderedRows: null,
      renderedAt: null,
      transitions: [],
      awaitingFirstItem: false,
    };
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

export function noteThreadStreamOpened(environmentId: string, threadId: string): void {
  const record = recordFor(environmentId, threadId);
  record.closedAt = null;
  transition(record, "opened");
  notify();
}

export function noteThreadStreamClosed(environmentId: string, threadId: string): void {
  const record = records.get(keyOf(environmentId, threadId));
  if (record === undefined) return;
  record.closedAt = clock();
  transition(record, "closed");
  notify();
}

/** A new subscription request; the first item it receives says whether it replayed or reloaded. */
export function noteThreadStreamSubscribed(
  environmentId: string,
  threadId: string,
  afterSequence: number | null,
): void {
  const record = recordFor(environmentId, threadId);
  record.subscriptions += 1;
  record.lastSubscribedAt = clock();
  record.awaitingFirstItem = true;
  transition(record, afterSequence === null ? "subscribe" : `subscribe after #${afterSequence}`);
  notify();
}

export function noteThreadStreamSnapshot(
  environmentId: string,
  threadId: string,
  sequence: number,
  visibleItems: number,
): void {
  const record = recordFor(environmentId, threadId);
  record.snapshots += 1;
  record.lastSequence = sequence;
  record.visibleItems = visibleItems;
  if (record.awaitingFirstItem) {
    record.awaitingFirstItem = false;
    record.lastStart = "snapshot";
  }
  transition(record, `snapshot #${sequence}`);
  notify();
}

export function noteThreadStreamEvents(
  environmentId: string,
  threadId: string,
  input: {
    readonly count: number;
    readonly sequence: number;
    readonly eventType: string | null;
    readonly itemOrdinal: number | null;
    readonly visibleItems: number | null;
    readonly status: string;
    readonly error: string | null;
  },
): void {
  const record = recordFor(environmentId, threadId);
  record.events += input.count;
  record.lastSequence = input.sequence;
  record.lastEventAt = clock();
  if (input.eventType !== null) record.lastEventType = input.eventType;
  if (
    input.itemOrdinal !== null &&
    (record.latestItemOrdinal === null || input.itemOrdinal > record.latestItemOrdinal)
  ) {
    record.latestItemOrdinal = input.itemOrdinal;
  }
  if (input.visibleItems !== null) record.visibleItems = input.visibleItems;
  if (record.awaitingFirstItem) {
    record.awaitingFirstItem = false;
    record.lastStart = "replay";
  }
  if (record.status !== input.status || record.error !== input.error) {
    record.status = input.status;
    record.error = input.error;
    transition(record, input.error === null ? input.status : `${input.status}: ${input.error}`);
  }
  if (listeners.size > 0) notify();
}

export function noteThreadStreamStatus(
  environmentId: string,
  threadId: string,
  status: string,
  error: string | null,
): void {
  const record = recordFor(environmentId, threadId);
  if (record.status === status && record.error === error) return;
  record.status = status;
  record.error = error;
  transition(record, error === null ? status : `${status}: ${error}`);
  notify();
}

/** What a client's feed drew from the thread, to tell a stalled list from a stalled stream. */
export function noteThreadFeedRendered(
  environmentId: string,
  threadId: string,
  renderedRows: number,
): void {
  const record = records.get(keyOf(environmentId, threadId));
  if (record === undefined || record.renderedRows === renderedRows) return;
  record.renderedRows = renderedRows;
  record.renderedAt = clock();
  if (listeners.size > 0) notify();
}

export function readThreadStreamDiagnostics(): ReadonlyArray<ThreadStreamDiagnostic> {
  return [...records.values()]
    .map(({ awaitingFirstItem: _awaiting, ...record }) => ({
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

function formatAge(now: number, at: number | null): string {
  if (at === null) return "never";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  return seconds < 120 ? `${seconds}s ago` : `${Math.round(seconds / 60)}m ago`;
}

export function formatThreadStreamReport(
  diagnostics: ReadonlyArray<ThreadStreamDiagnostic>,
  now: number = clock(),
): string {
  if (diagnostics.length === 0) return "No thread streams opened since the app started.";
  return diagnostics
    .map((d) =>
      [
        `Thread ${d.threadId} (environment ${d.environmentId})${d.closedAt === null ? "" : ` closed ${formatAge(now, d.closedAt)}`}`,
        `  status: ${d.status}${d.error === null ? "" : ` (${d.error})`}`,
        `  subscriptions: ${d.subscriptions}, last ${formatAge(now, d.lastSubscribedAt)}, started by ${d.lastStart ?? "nothing yet"}`,
        `  events: ${d.events}, last #${d.lastSequence ?? "-"} ${d.lastEventType ?? ""} ${formatAge(now, d.lastEventAt)}`,
        `  snapshots: ${d.snapshots}, latest item ordinal: ${d.latestItemOrdinal ?? "-"}`,
        `  visible items: ${d.visibleItems ?? "-"}, feed rows drawn: ${d.renderedRows ?? "-"} (${formatAge(now, d.renderedAt)})`,
        `  recent: ${d.transitions.map((t) => `${t.what} (${formatAge(now, t.at)})`).join(", ")}`,
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
