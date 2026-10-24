/**
 * What the agent cursor overlay shows, decided from what the lease proxy already sees: each
 * driver call, its reply, and the control's pauses and end (#1214). The proxy writes the
 * commands this returns to the helper before it forwards the call that caused them. A capture
 * then never contains the overlay.
 *
 * - An input call on a window shows the cursor there, "acting" until it answers, then "resting".
 * - A call that captures pixels hides everything until it answers. A recording hides everything
 *   until it stops. A script or batch counts as a capture, because it can take screenshots the
 *   proxy cannot see ahead of time.
 * - A pause (a person's input, takeover, a secret field) or the control's end hides it.
 *
 * Points are fractions of the last screenshot the driver returned for that window. The helper
 * maps them onto the window's current frame. Without a screenshot size, or for an element or a
 * zoomed region, the glow shows without a cursor point.
 *
 * @module ComputerUseOverlay
 */
import type {
  ComputerUseLeaseUpdate,
  ComputerUseOverlayCommand,
  ComputerUseOverlayHideReason,
  ComputerUseOverlayPoint,
} from "@goat/contracts";

/** Input the driver delivers to a window, with the argument names that carry its point. */
const INPUT_POINTS: Readonly<Record<string, readonly [string, string] | null>> = {
  click: ["x", "y"],
  double_click: ["x", "y"],
  right_click: ["x", "y"],
  type_text: ["x", "y"],
  press_key: ["x", "y"],
  hotkey: ["x", "y"],
  scroll: ["x", "y"],
  move_cursor: ["x", "y"],
  drag: ["from_x", "from_y"],
  set_value: null,
  invoke_menu: null,
};

/** Calls whose answer can carry pixels of the screen. */
const CAPTURES: ReadonlySet<string> = new Set([
  "get_window_state",
  "get_desktop_state",
  "zoom",
  "verify_state",
  "parse_visual_regions",
  "page",
  "run_steps",
  "run_script",
  "replay_trajectory",
]);

interface Target {
  readonly pid: number;
  readonly windowId: number;
  readonly point?: ComputerUseOverlayPoint;
}

export interface OverlayState {
  readonly target: Target | undefined;
  readonly acting: ReadonlySet<string>;
  readonly capturing: ReadonlySet<string>;
  readonly recording: boolean;
  readonly pause: "human_input" | "takeover" | "private" | undefined;
  readonly ended: boolean;
  /** Pixel size of the last screenshot per window id. */
  readonly shots: ReadonlyMap<number, { readonly width: number; readonly height: number }>;
  /** Window ids of calls in flight that return a window screenshot. */
  readonly snapshots: ReadonlyMap<string, number>;
  readonly shown: ComputerUseOverlayCommand | undefined;
}

export const initialOverlayState: OverlayState = {
  target: undefined,
  acting: new Set(),
  capturing: new Set(),
  recording: false,
  pause: undefined,
  ended: false,
  shots: new Map(),
  snapshots: new Map(),
  shown: undefined,
};

export type OverlayEvent =
  | { readonly type: "call"; readonly id: string; readonly name: string; readonly args: unknown }
  | {
      readonly type: "reply";
      readonly id: string;
      /** The screenshot in the reply, when it has one. */
      readonly image?: { readonly width: number; readonly height: number };
    }
  | { readonly type: "lease"; readonly update: ComputerUseLeaseUpdate };

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

const integer = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) ? value : undefined;

const finite = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** The window a call targets, top level or as an exact window target. */
function windowOf(args: Readonly<Record<string, unknown>> | undefined) {
  const target = record(args?.target);
  const pid = integer(args?.pid) ?? integer(target?.pid);
  const windowId = integer(args?.window_id) ?? integer(target?.window_id);
  return pid === undefined || windowId === undefined ? undefined : { pid, windowId };
}

const clamp = (value: number) => Math.min(1, Math.max(0, value));

function pointOf(
  state: OverlayState,
  name: string,
  args: Readonly<Record<string, unknown>> | undefined,
  windowId: number,
): ComputerUseOverlayPoint | undefined {
  const keys = INPUT_POINTS[name];
  const shot = state.shots.get(windowId);
  if (!keys || !shot || args?.from_zoom === true) return undefined;
  const x = finite(args?.[keys[0]]);
  const y = finite(args?.[keys[1]]);
  if (x === undefined || y === undefined || shot.width <= 0 || shot.height <= 0) return undefined;
  return { fx: clamp(x / shot.width), fy: clamp(y / shot.height) };
}

function without<T>(set: ReadonlySet<T>, value: T): ReadonlySet<T> {
  if (!set.has(value)) return set;
  const next = new Set(set);
  next.delete(value);
  return next;
}

function hideReason(state: OverlayState): ComputerUseOverlayHideReason | undefined {
  if (state.ended) return "ended";
  if (state.pause) return state.pause;
  if (state.capturing.size > 0 || state.recording) return "capture";
  if (!state.target) return "idle";
  return undefined;
}

function desired(state: OverlayState): ComputerUseOverlayCommand {
  const reason = hideReason(state);
  if (reason !== undefined || !state.target) return { op: "hide", reason: reason ?? "idle" };
  const { pid, windowId, point } = state.target;
  return {
    op: "show",
    pid,
    windowId,
    ...(point ? { point } : {}),
    phase: state.acting.size > 0 ? "acting" : "resting",
  };
}

const same = (a: ComputerUseOverlayCommand | undefined, b: ComputerUseOverlayCommand) =>
  a !== undefined && JSON.stringify(a) === JSON.stringify(b);

function apply(state: OverlayState, event: OverlayEvent): OverlayState {
  switch (event.type) {
    case "call": {
      const args = record(event.args);
      if (event.name === "start_recording") return { ...state, recording: true };
      if (event.name === "stop_recording") return { ...state, recording: false };
      const window = windowOf(args);
      const capture =
        CAPTURES.has(event.name) &&
        !(event.name === "get_window_state" && args?.include_screenshot === false);
      if (capture) {
        const snapshots =
          event.name === "get_window_state" && window
            ? new Map(state.snapshots).set(event.id, window.windowId)
            : state.snapshots;
        return { ...state, capturing: new Set(state.capturing).add(event.id), snapshots };
      }
      if (!(event.name in INPUT_POINTS) || !window) return state;
      const point = pointOf(state, event.name, args, window.windowId);
      return {
        ...state,
        target: { ...window, ...(point ? { point } : {}) },
        acting: new Set(state.acting).add(event.id),
      };
    }
    case "reply": {
      const windowId = state.snapshots.get(event.id);
      const shots =
        windowId !== undefined && event.image
          ? new Map(state.shots).set(windowId, event.image)
          : state.shots;
      const snapshots =
        windowId === undefined
          ? state.snapshots
          : new Map([...state.snapshots].filter(([id]) => id !== event.id));
      return {
        ...state,
        acting: without(state.acting, event.id),
        capturing: without(state.capturing, event.id),
        shots,
        snapshots,
      };
    }
    case "lease": {
      const update = event.update;
      if (update.state === "ended") return { ...state, ended: true };
      if (update.state === "paused") return { ...state, pause: update.reason };
      return { ...state, pause: undefined };
    }
  }
}

/**
 * The next state and the commands to send the helper, in order, before the proxy forwards the
 * call or reply that caused them. Unchanged output sends nothing.
 */
export function overlayStep(
  state: OverlayState,
  event: OverlayEvent,
): readonly [OverlayState, ReadonlyArray<ComputerUseOverlayCommand>] {
  const next = apply(state, event);
  const command = desired(next);
  if (same(state.shown, command)) return [next, []];
  return [{ ...next, shown: command }, [command]];
}
/**
 * The pixel size of the first PNG screenshot in a driver reply, read from its IHDR header
 * without decoding the image. Window snapshots are PNG; anything else gives no size.
 */
export function replyImageSize(result: unknown): { width: number; height: number } | undefined {
  const content = record(result)?.content;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    const image = record(block);
    if (image?.type !== "image" || image.mimeType !== "image/png") continue;
    if (typeof image.data !== "string") return undefined;
    // Signature (8) + IHDR length and type (8) + width (4) + height (4) = 24 bytes = 32 base64.
    const head = Buffer.from(image.data.slice(0, 32), "base64");
    if (head.length < 24 || head.toString("latin1", 12, 16) !== "IHDR") return undefined;
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
  }
  return undefined;
}
