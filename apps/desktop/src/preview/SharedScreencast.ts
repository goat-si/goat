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

type FrameParams = ScreencastParams & { readonly sessionId: number };
type NativeCredit = { readonly sessionId: number; remaining: number };
type Delivery = { readonly sessionId: number; readonly credit?: NativeCredit };

const MAX_HELD_NATIVE_FRAMES = 8;

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
  readonly frame: (params: ScreencastParams) => void;
  readonly ack: (viewer: string, sessionId: unknown) => void;
  /** Ends the screencast for every viewer, as when the relay connection closes. */
  readonly close: () => void;
}

export function createSharedScreencast(
  send: (method: string, params: ScreencastParams) => Promise<unknown>,
  deliver: (viewer: string, frame: FrameParams) => void,
): SharedScreencast {
  const viewers = new Map<string, ViewerRequest>();
  const outstanding = new Map<string, Delivery>();
  const skipped = new Map<string, FrameParams>();
  const heldNative: number[] = [];
  const clear = () => {
    outstanding.clear();
    skipped.clear();
    heldNative.length = 0;
  };
  /** What Chromium runs now; null while stopped. */
  let running: ScreencastParams | null = null;
  let stopping = false;
  let stopFailed = false;
  // Starts and stops reach Chromium one at a time, each computed from the viewers then.
  let queue: Promise<void> = Promise.resolve();
  let syncsInFlight = 0;

  const ackPage = (sessionId: number) =>
    void send("Page.screencastFrameAck", { sessionId }).catch(() => undefined);

  const sendFrame = (viewer: string, frame: FrameParams, credit?: NativeCredit) => {
    outstanding.set(viewer, { sessionId: frame.sessionId, ...(credit ? { credit } : {}) });
    if (credit) credit.remaining++;
    deliver(viewer, frame);
  };

  const release = (viewer: string) => {
    const credit = outstanding.get(viewer)?.credit;
    outstanding.delete(viewer);
    if (credit && --credit.remaining === 0) ackPage(credit.sessionId);
  };

  const releaseUnusedCredits = () => {
    if (skipped.size === 0) for (const id of heldNative.splice(0)) ackPage(id);
  };

  const remove = (viewer: string) => {
    const removed = viewers.delete(viewer);
    skipped.delete(viewer);
    release(viewer);
    releaseUnusedCredits();
    return removed;
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
      clear();
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
    clear();
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
    if (!remove(viewer)) return;
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
          else remove(viewer);
          await sync().catch(() => undefined);
        }
        throw cause;
      }
    },
    stop: (viewer) => {
      remove(viewer);
      return sync();
    },
    leave,
    frame: (params) => {
      const sessionId = params["sessionId"];
      if (stopping || typeof sessionId !== "number") return;
      if (viewers.size === 0) {
        // A failed last stop leaves Chromium streaming. A frame is its retry signal.
        if (running !== null && syncsInFlight === 0) void sync().catch(() => undefined);
        return;
      }
      const frame = { ...params, sessionId };
      const credit = { sessionId, remaining: 0 };
      for (const viewer of viewers.keys()) {
        if (outstanding.has(viewer)) skipped.set(viewer, frame);
        else sendFrame(viewer, frame, credit);
      }
      if (credit.remaining === 0) {
        if (heldNative.length === MAX_HELD_NATIVE_FRAMES) {
          const oldest = heldNative.shift();
          if (oldest !== undefined) ackPage(oldest);
        }
        heldNative.push(sessionId);
      }
    },
    ack: (viewer, sessionId) => {
      const sent = outstanding.get(viewer);
      if (!sent || sent.sessionId !== sessionId) return;
      release(viewer);
      const latest = skipped.get(viewer);
      if (latest) {
        skipped.delete(viewer);
        sendFrame(viewer, latest);
        const native = heldNative.shift();
        if (native !== undefined) ackPage(native);
      }
      releaseUnusedCredits();
    },
    close: () => {
      viewers.clear();
      clear();
      void sync().catch(() => undefined);
    },
  };
}
