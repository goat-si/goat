import type { EnvironmentId } from "@goat/contracts";

// The server reads one Library file per connection at a time, so each server gets one read in
// flight and the next waits for it instead of hearing "busy". A file the person opens waits only
// for the one chunk in flight, then holds the server for its whole read, ahead of every waiting
// preview; opens run in the order they were asked. Only the newest few previews wait at all.
export const MAX_WAITING_PREVIEW_READS = 4;

interface Waiting {
  readonly chatKey: string | null;
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
  run: () => Promise<T>,
  queue: "opened" | "previews",
  chatKey: string | null,
) {
  let lane = lanes.get(environmentId);
  if (lane === undefined) {
    lane = { busy: false, opened: [], previews: [] };
    lanes.set(environmentId, lane);
  }
  const owner = lane;
  const settled = Promise.withResolvers<T | null>();
  const entry: Waiting = {
    chatKey,
    start: () => {
      run()
        .then(settled.resolve, settled.reject)
        .finally(() => {
          owner.busy = false;
          startNext(environmentId, owner);
        });
    },
    drop: () => settled.resolve(null),
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
  return { result: settled.promise, cancel };
}

/**
 * A file the person opened, from a chat card or the Library: `run` reads all of it while it holds
 * the server, after the one read already in flight and before every waiting preview. Null when
 * aborted before it started; once started, it lets the server go when `run` settles.
 */
export function openBotFileRead<T>(
  environmentId: EnvironmentId,
  run: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T | null> {
  if (signal?.aborted) return Promise.resolve(null);
  const read = enqueue(environmentId, run, "opened", null);
  signal?.addEventListener("abort", read.cancel, { once: true });
  return read.result;
}

/**
 * A card's preview read in chat `chatKey`, one request. Null when it never ran: cancelled while
 * waiting, pushed out by newer previews past the limit, or its chat left. One already in flight
 * finishes; its card ignores the answer.
 */
export function queuePreviewRead<T>(
  environmentId: EnvironmentId,
  chatKey: string,
  request: () => Promise<T>,
) {
  return enqueue(environmentId, request, "previews", chatKey);
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
