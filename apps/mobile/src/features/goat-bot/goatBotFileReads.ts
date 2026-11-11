import type { EnvironmentId } from "@goat/contracts";

// The server reads one Library file per connection at a time. Previews take turns: one in flight
// per server and only the newest few waiting. A file the person opens never waits its turn: it
// interrupts the preview in flight, which is read again once the open is done.
export const MAX_WAITING_PREVIEW_READS = 4;

interface Waiting {
  readonly chatKey: string;
  /** Interrupted by an open: read again first, and never pushed out. */
  again: boolean;
  /** Its card has gone: an interrupted read is not read again. */
  cancelled: boolean;
  readonly start: () => InFlight;
  readonly drop: () => void;
}

interface InFlight {
  readonly entry: Waiting;
  /** Settles when the server has answered this read, used or not. */
  readonly done: Promise<void>;
  /** Its answer, when it comes, is not this preview's. */
  readonly abort: () => void;
}

interface Lane {
  current: InFlight | null;
  opens: number;
  readonly previews: Waiting[];
}

const lanes = new Map<EnvironmentId, Lane>();
const ignore = () => {};

function laneOf(environmentId: EnvironmentId): Lane {
  let lane = lanes.get(environmentId);
  if (lane === undefined) {
    lane = { current: null, opens: 0, previews: [] };
    lanes.set(environmentId, lane);
  }
  return lane;
}

function startNext(environmentId: EnvironmentId, lane: Lane) {
  if (lane.current !== null || lane.opens > 0) return;
  const next = lane.previews.shift();
  if (next === undefined) {
    if (lanes.get(environmentId) === lane) lanes.delete(environmentId);
    return;
  }
  const flight = next.start();
  lane.current = flight;
  void flight.done.then(() => {
    if (lane.current !== flight) return;
    lane.current = null;
    startNext(environmentId, lane);
  });
}

/** Settles true when `done` does, false if `signal` aborts first. */
function settledUnlessAborted(done: Promise<void>, signal: AbortSignal | undefined) {
  if (signal === undefined) return done.then(() => true);
  if (signal.aborted) return Promise.resolve(false);
  const aborted = Promise.withResolvers<boolean>();
  const onAbort = () => aborted.resolve(false);
  signal.addEventListener("abort", onAbort, { once: true });
  return Promise.race([done.then(() => true), aborted.promise]).finally(() =>
    signal.removeEventListener("abort", onAbort),
  );
}

/**
 * A file the person opened: `run` reads all of it now. A preview in flight on that server is
 * interrupted and read again afterwards. When `busy` says the server was still on that preview's
 * chunk, the open waits for the chunk's answer and tries once more. Null when aborted first.
 */
export async function openBotFileRead<T>(
  environmentId: EnvironmentId,
  run: () => Promise<T>,
  signal?: AbortSignal,
  busy?: (result: T) => boolean,
): Promise<T | null> {
  if (signal?.aborted) return null;
  const lane = laneOf(environmentId);
  lane.opens += 1;
  const interrupted = lane.current;
  if (interrupted !== null) {
    lane.current = null;
    interrupted.abort();
    if (interrupted.entry.cancelled) interrupted.entry.drop();
    else {
      interrupted.entry.again = true;
      lane.previews.unshift(interrupted.entry);
    }
  }
  try {
    const first = await run();
    if (interrupted === null || busy?.(first) !== true) return first;
    if (!(await settledUnlessAborted(interrupted.done, signal))) return null;
    return await run();
  } finally {
    lane.opens -= 1;
    startNext(environmentId, lane);
  }
}

/**
 * A card's preview read in chat `chatKey`, one request. Null when it never ran: cancelled while
 * waiting, pushed out by newer previews past the limit, or its chat left. An interrupted read
 * waits again and resolves with the read that follows.
 */
export function queuePreviewRead<T>(
  environmentId: EnvironmentId,
  chatKey: string,
  request: () => Promise<T>,
) {
  const lane = laneOf(environmentId);
  const settled = Promise.withResolvers<T | null>();
  const entry: Waiting = {
    chatKey,
    again: false,
    cancelled: false,
    start: () => {
      let aborted = false;
      const answer = request();
      answer.then(
        (value) => {
          if (!aborted) settled.resolve(value);
        },
        (error: unknown) => {
          if (!aborted) settled.reject(error);
        },
      );
      return {
        entry,
        done: answer.then(ignore, ignore),
        abort: () => {
          aborted = true;
        },
      };
    },
    drop: () => settled.resolve(null),
  };
  lane.previews.push(entry);
  if (lane.previews.length > MAX_WAITING_PREVIEW_READS) {
    const oldest = lane.previews.findIndex((waiting) => !waiting.again);
    if (oldest !== -1) lane.previews.splice(oldest, 1)[0]?.drop();
  }
  startNext(environmentId, lane);
  const cancel = () => {
    entry.cancelled = true;
    const at = lane.previews.indexOf(entry);
    if (at === -1) return;
    lane.previews.splice(at, 1);
    entry.drop();
  };
  return { result: settled.promise, cancel };
}

/** The person left chat `chatKey`: its waiting previews never start. */
export function dropChatPreviewReads(chatKey: string): void {
  for (const lane of lanes.values()) {
    for (const entry of lane.previews.filter((waiting) => waiting.chatKey === chatKey)) {
      lane.previews.splice(lane.previews.indexOf(entry), 1);
      entry.drop();
    }
  }
}
