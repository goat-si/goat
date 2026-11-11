import type { EnvironmentId } from "@goat/contracts";

// The server reads one Library file per connection at a time. Previews take turns, one in flight per
// server and only the newest few waiting; none starts while a file the person opened is being read.
// An open never waits for a preview: it starts at once, beside one already in flight.
export const MAX_WAITING_PREVIEW_READS = 4;

interface Waiting {
  readonly chatKey: string;
  readonly start: () => void;
  readonly drop: () => void;
}

interface Lane {
  previewRunning: boolean;
  opens: number;
  readonly previews: Waiting[];
}

const lanes = new Map<EnvironmentId, Lane>();

function laneOf(environmentId: EnvironmentId): Lane {
  let lane = lanes.get(environmentId);
  if (lane === undefined) {
    lane = { previewRunning: false, opens: 0, previews: [] };
    lanes.set(environmentId, lane);
  }
  return lane;
}

function startNext(environmentId: EnvironmentId, lane: Lane) {
  if (lane.previewRunning || lane.opens > 0) return;
  const next = lane.previews.shift();
  if (next === undefined) {
    if (lanes.get(environmentId) === lane) lanes.delete(environmentId);
    return;
  }
  lane.previewRunning = true;
  next.start();
}

/**
 * A file the person opened: `run` reads all of it now, whatever preview is in flight. Null when
 * aborted before it started. Waiting previews start only after it settles.
 */
export async function openBotFileRead<T>(
  environmentId: EnvironmentId,
  run: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T | null> {
  if (signal?.aborted) return null;
  const lane = laneOf(environmentId);
  lane.opens += 1;
  try {
    return await run();
  } finally {
    lane.opens -= 1;
    startNext(environmentId, lane);
  }
}

/**
 * A card's preview read in chat `chatKey`, one request. Null when it never ran: cancelled while
 * waiting, pushed out by newer previews past the limit, or its chat left.
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
    start: () => {
      request()
        .then(settled.resolve, settled.reject)
        .finally(() => {
          lane.previewRunning = false;
          startNext(environmentId, lane);
        });
    },
    drop: () => settled.resolve(null),
  };
  lane.previews.push(entry);
  if (lane.previews.length > MAX_WAITING_PREVIEW_READS) lane.previews.shift()?.drop();
  startNext(environmentId, lane);
  const cancel = () => {
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
