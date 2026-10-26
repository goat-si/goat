/**
 * One debugger screencast shared by every relay session that asked for frames.
 *
 * Electron gives a webContents one debugger session, so each viewer's
 * `Page.startScreencast` would otherwise replace the others' and its stop would
 * end their frames. Chromium also counts acks per screencast rather than per
 * frame, so the page gets one ack per frame, once every viewer it reached has
 * sent its own.
 */

type ScreencastParams = Record<string, unknown>;
type ViewerRequest = { readonly params: ScreencastParams; readonly token: object };

interface PendingFrame {
  readonly sessionId: unknown;
  readonly owers: Set<string>;
}

const number = (value: unknown) => (typeof value === "number" ? value : undefined);

/** Parameters that give every viewer at least what it asked for. */
const merge = (requests: ReadonlyArray<ScreencastParams>): ScreencastParams => {
  const largest = (key: string) => {
    const values = requests.map((params) => number(params[key]));
    // A viewer that names no bound wants the page's full size.
    return values.includes(undefined) ? undefined : Math.max(...(values as Array<number>));
  };
  const qualities = requests.flatMap((params) => number(params["quality"]) ?? []);
  const everyNth = requests.map((params) => number(params["everyNthFrame"]) ?? 1);
  const formats = new Set(requests.map((params) => params["format"]));
  const merged: ScreencastParams = {
    format: formats.has("png") ? "png" : formats.has("jpeg") ? "jpeg" : undefined,
    quality: qualities.length > 0 ? Math.max(...qualities) : undefined,
    maxWidth: largest("maxWidth"),
    maxHeight: largest("maxHeight"),
    everyNthFrame: Math.min(...everyNth) > 1 ? Math.min(...everyNth) : undefined,
  };
  return Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== undefined));
};

const sameParams = (left: ScreencastParams, right: ScreencastParams) =>
  JSON.stringify(left) === JSON.stringify(right);

export interface SharedScreencast {
  readonly start: (viewer: string, params: ScreencastParams) => Promise<void>;
  readonly stop: (viewer: string) => Promise<void>;
  /** Lets go of a viewer that left without stopping, such as a detached session. */
  readonly leave: (viewer: string) => void;
  /** The viewers a frame goes to. */
  readonly frame: (params: { readonly sessionId?: unknown }) => ReadonlyArray<string>;
  readonly ack: (viewer: string, sessionId: unknown) => void;
  /** Ends the screencast for every viewer, as when the relay connection closes. */
  readonly close: () => void;
}

export function createSharedScreencast(
  send: (method: string, params: ScreencastParams) => Promise<unknown>,
): SharedScreencast {
  const viewers = new Map<string, ViewerRequest>();
  let pending: Array<PendingFrame> = [];
  /** What Chromium runs now; null while stopped. */
  let running: ScreencastParams | null = null;
  let stopping = false;
  let stopFailed = false;
  // Starts and stops reach Chromium one at a time, each computed from the viewers then.
  let queue: Promise<void> = Promise.resolve();
  let syncsInFlight = 0;

  const ackPage = (frame: PendingFrame) =>
    void send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => undefined);

  const release = (viewer: string) => {
    pending = pending.filter((frame) => {
      if (!frame.owers.delete(viewer) || frame.owers.size > 0) return true;
      ackPage(frame);
      return false;
    });
  };

  const apply = async () => {
    const wanted =
      viewers.size > 0 ? merge([...viewers.values()].map(({ params }) => params)) : null;
    if (
      !stopFailed &&
      (wanted === null ? running === null : running !== null && sameParams(running, wanted))
    )
      return;
    // Chromium answers a second start with "Screencast is already active". A new
    // screencast starts its own ack count, so frames still owed need none.
    if (running !== null) {
      stopping = true;
      pending = [];
      try {
        await send("Page.stopScreencast", {});
        running = null;
        stopFailed = false;
      } catch (cause) {
        stopFailed = true;
        throw cause;
      } finally {
        stopping = false;
      }
    }
    if (wanted === null) return;
    pending = [];
    await send("Page.startScreencast", wanted);
    running = wanted;
  };

  const sync = () => {
    syncsInFlight++;
    const applied = queue.then(apply);
    queue = applied.catch(() => undefined);
    void queue.then(() => {
      syncsInFlight--;
    });
    return applied;
  };

  const leave = (viewer: string) => {
    if (!viewers.delete(viewer)) return;
    release(viewer);
    void sync().catch(() => undefined);
  };

  return {
    start: async (viewer, params) => {
      const previous = viewers.get(viewer);
      const token = {};
      viewers.set(viewer, { params, token });
      try {
        await sync();
      } catch (cause) {
        if (viewers.get(viewer)?.token === token) {
          if (previous) viewers.set(viewer, previous);
          else viewers.delete(viewer);
          await sync().catch(() => undefined);
        }
        throw cause;
      }
    },
    stop: (viewer) => {
      viewers.delete(viewer);
      release(viewer);
      return sync();
    },
    leave,
    frame: (params) => {
      if (stopping) return [];
      if (viewers.size === 0) {
        // A failed last stop leaves Chromium streaming. A frame is its retry signal.
        if (running !== null && syncsInFlight === 0) void sync().catch(() => undefined);
        return [];
      }
      pending.push({ sessionId: params.sessionId, owers: new Set(viewers.keys()) });
      return [...viewers.keys()];
    },
    ack: (viewer, sessionId) => {
      const frame = pending.find(
        (candidate) => candidate.sessionId === sessionId && candidate.owers.has(viewer),
      );
      if (!frame) return;
      frame.owers.delete(viewer);
      if (frame.owers.size > 0) return;
      pending = pending.filter((candidate) => candidate !== frame);
      ackPage(frame);
    },
    close: () => {
      viewers.clear();
      pending = [];
      void sync().catch(() => undefined);
    },
  };
}
