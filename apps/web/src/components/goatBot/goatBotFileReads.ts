import type { EnvironmentId } from "@goat/contracts";

// The server reads one Library file per connection at a time, so each server gets one chunk
// request in flight; the next waits for it instead of hearing "busy". An open file's reads go
// before card previews, and only the newest few previews wait at all.
export const MAX_WAITING_PREVIEW_READS = 4;

interface Waiting {
  readonly start: () => void;
  readonly drop: () => void;
}

interface Lane {
  busy: boolean;
  readonly opened: Waiting[];
  readonly previews: Waiting[];
}

const lanes = new Map<EnvironmentId, Lane>();

function startNext(environmentId: EnvironmentId, lane: Lane) {
  if (lane.busy) return;
  const next = lane.opened.shift() ?? lane.previews.shift();
  if (next === undefined) {
    if (lanes.get(environmentId) === lane) lanes.delete(environmentId);
    return;
  }
  lane.busy = true;
  next.start();
}

function enqueue<T>(
  environmentId: EnvironmentId,
  request: () => Promise<T>,
  queue: "opened" | "previews",
) {
  let lane = lanes.get(environmentId);
  if (lane === undefined) {
    lane = { busy: false, opened: [], previews: [] };
    lanes.set(environmentId, lane);
  }
  const owner = lane;
  let resolve: (value: T | null) => void = () => {};
  let reject: (reason: unknown) => void = () => {};
  const result = new Promise<T | null>((onValue, onError) => {
    resolve = onValue;
    reject = onError;
  });
  const entry: Waiting = {
    start: () => {
      request()
        .then(resolve, reject)
        .finally(() => {
          owner.busy = false;
          startNext(environmentId, owner);
        });
    },
    drop: () => resolve(null),
  };
  const waiting = owner[queue];
  waiting.push(entry);
  if (queue === "previews" && waiting.length > MAX_WAITING_PREVIEW_READS) waiting.shift()?.drop();
  startNext(environmentId, owner);
  const cancel = () => {
    const at = waiting.indexOf(entry);
    if (at === -1) return;
    waiting.splice(at, 1);
    entry.drop();
  };
  return { result, cancel };
}

/** A read for a file the person opened: it goes ahead of every waiting preview. */
export function afterLastChunkRequest<T>(environmentId: EnvironmentId, request: () => Promise<T>) {
  return enqueue(environmentId, request, "opened").result as Promise<T>;
}

/**
 * A card's preview read. Null when it never ran: cancelled while waiting, or pushed out by newer
 * previews past the limit.
 */
export function queuePreviewRead<T>(environmentId: EnvironmentId, request: () => Promise<T>) {
  return enqueue(environmentId, request, "previews");
}
