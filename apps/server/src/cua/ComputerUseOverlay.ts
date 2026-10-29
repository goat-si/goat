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
 * - An explicit pause, takeover or secret field, or the control's end hides it.
 *
 * Points are fractions of the last screenshot the driver returned for that window. The helper
 * maps them onto the window's current frame. Without a screenshot size, or for an element or a
 * zoomed region, the glow shows without a cursor point.
 * A code-mode call instead carries its cursor: the host-owned owner, and for an element action
 * the element's center, which the host read from the element's frame and sent with that call.
 *
 * @module ComputerUseOverlay
 */
import type {
  ComputerUseOverlayCommand,
  AgentCursorEvent,
  AgentCursorOwner,
  ComputerUseOverlayHideReason,
  ComputerUseOverlayPoint,
  ComputerUsePauseReason,
} from "@goat/contracts";

import { targetOf } from "./computerUseTarget.ts";

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

/** Window inputs that act at the current focus when given neither coordinates nor an element. */
const NON_SPATIAL_INPUTS: ReadonlySet<string> = new Set([
  "press_key",
  "hotkey",
  "type_text",
  "set_value",
  "invoke_menu",
]);

/** Calls whose answer can carry pixels of the screen. */
const CAPTURES: ReadonlySet<string> = new Set([
  "get_window_state",
  "wait_for_window_settle",
  "get_desktop_state",
  "zoom",
  "verify_state",
  "parse_visual_regions",
  "page",
  "run_steps",
  "run_script",
  "replay_trajectory",
]);

export const overlayCallCaptures = (name: string, args: unknown): boolean =>
  CAPTURES.has(name) &&
  !(name === "get_window_state" && record(args)?.include_screenshot === false) &&
  !(name === "verify_state" && record(args)?.include_screenshot !== true);

interface Target {
  readonly pid: number;
  readonly windowId: number;
  readonly point?: ComputerUseOverlayPoint;
  readonly owner?: AgentCursorOwner;
}

export interface OverlayState {
  readonly target: Target | undefined;
  readonly acting: ReadonlySet<string>;
  readonly capturing: ReadonlySet<string>;
  readonly recording: boolean;
  /** stop_recording calls in flight: the recording runs until one answers without an error. */
  readonly stopping: ReadonlySet<string>;
  readonly pause: ComputerUsePauseReason | undefined;
  readonly ended: boolean;
  /** Pixel size of the last screenshot per window id. */
  readonly shots: ReadonlyMap<number, { readonly width: number; readonly height: number }>;
  /** Window ids of calls in flight that return a window screenshot. */
  readonly snapshots: ReadonlyMap<string, number>;
  readonly shown: ComputerUseOverlayCommand | undefined;
  readonly scoped: AgentCursorEvent | undefined;
  readonly legacyTargetActive: boolean;
  readonly directActing: ReadonlySet<string>;
}

export const initialOverlayState: OverlayState = {
  target: undefined,
  acting: new Set(),
  capturing: new Set(),
  recording: false,
  stopping: new Set(),
  pause: undefined,
  ended: false,
  shots: new Map(),
  snapshots: new Map(),
  shown: undefined,
  scoped: undefined,
  legacyTargetActive: false,
  directActing: new Set(),
};

export type OverlayEvent =
  | { readonly type: "cursor"; readonly event: AgentCursorEvent }
  | {
      readonly type: "call";
      readonly id: string;
      readonly name: string;
      readonly args: unknown;
      readonly codeMode?: boolean;
      /** The host's cursor for this call; its point wins over one read from its arguments. */
      readonly cursor?: {
        readonly owner: AgentCursorOwner;
        readonly point?: ComputerUseOverlayPoint;
      };
    }
  | {
      readonly type: "reply";
      readonly id: string;
      /** The screenshot in the reply, when it has one. */
      readonly image?: { readonly width: number; readonly height: number };
      /** The call answered with an error, so whatever it was to change may not have changed. */
      readonly failed?: boolean;
    }
  /** The control paused or ended. The proxy then stops this helper; a resume starts a new one. */
  | { readonly type: "pause"; readonly reason: ComputerUsePauseReason }
  | { readonly type: "end" };

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

const finite = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

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
  // The macOS helper ends its MCP session on a pause or end reason; only the lease's own pause and
  // end may send one. A target's cursor ending, turning private or being taken over only hides.
  if (state.scoped?.op === "hide") return "idle";
  if (!state.target) return "idle";
  return undefined;
}

const sameOwner = (a: AgentCursorOwner, b: AgentCursorOwner) =>
  a.environmentId === b.environmentId &&
  a.runId === b.runId &&
  a.turnId === b.turnId &&
  a.targetId === b.targetId &&
  a.generation === b.generation;

const sameAuthority = (a: AgentCursorOwner, b: AgentCursorOwner) =>
  a.environmentId === b.environmentId &&
  a.runId === b.runId &&
  a.turnId === b.turnId &&
  b.generation >= a.generation;

/**
 * The owner a code-mode call names, when its own phase events have not reached the proxy yet:
 * calls can overtake them. It shows at sequence 0, so the owner's first phase still supersedes it.
 */
function callOwner(
  state: OverlayState,
  owner: AgentCursorOwner | undefined,
  window: { readonly pid: number; readonly windowId: number },
  point: ComputerUseOverlayPoint | undefined,
): AgentCursorEvent | undefined {
  const current = state.scoped;
  if (owner === undefined || (current !== undefined && sameOwner(current.identity, owner)))
    return current;
  if (
    current !== undefined &&
    current.op !== "hide" &&
    owner.generation <= current.identity.generation
  )
    return current;
  return { op: "show", identity: owner, phase: "acting", ...window, ...(point ? { point } : {}) };
}

function desired(state: OverlayState): ComputerUseOverlayCommand {
  const reason = hideReason(state);
  if (reason !== undefined || !state.target)
    return state.scoped === undefined || state.legacyTargetActive
      ? { op: "hide", reason: reason ?? "idle" }
      : { op: "hide", identity: state.scoped.identity, phase: "hidden", reason: reason ?? "idle" };
  const { pid, windowId, point } = state.target;
  if (state.scoped?.op === "show" && !state.legacyTargetActive)
    return {
      op: "show",
      identity: state.scoped.identity,
      pid,
      windowId,
      ...(point ? { point } : {}),
      phase: state.acting.size > 0 ? "acting" : state.scoped.phase,
    };
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

/** Whether the overlay takes a scoped cursor event over the owner it holds. */
export function cursorAccepted(state: OverlayState, event: AgentCursorEvent): boolean {
  const previous = state.scoped?.identity;
  const next = event.identity;
  if (previous === undefined) return true;
  const sameOwner =
    previous.environmentId === next.environmentId &&
    previous.runId === next.runId &&
    previous.turnId === next.turnId &&
    previous.targetId === next.targetId &&
    previous.generation === next.generation;
  return sameOwner
    ? next.sequence > previous.sequence && !(state.scoped?.op === "hide" && event.op === "show")
    : state.scoped?.op === "hide" || next.generation > previous.generation;
}

function apply(state: OverlayState, event: OverlayEvent): OverlayState {
  switch (event.type) {
    case "cursor": {
      if (!cursorAccepted(state, event.event)) return state;
      const next = event.event;
      const target =
        next.op !== "show"
          ? state.target
          : next.pid !== undefined && next.windowId !== undefined && next.point !== undefined
            ? { pid: next.pid, windowId: next.windowId, point: next.point, owner: next.identity }
            : state.target?.owner !== undefined && sameAuthority(state.target.owner, next.identity)
              ? { ...state.target, owner: next.identity }
              : state.directActing.size > 0
                ? state.target
                : undefined;
      return {
        ...state,
        scoped: next,
        target,
        legacyTargetActive: state.directActing.size > 0 ? state.legacyTargetActive : false,
      };
    }
    case "call": {
      const args = record(event.args);
      if (event.name === "start_recording") return { ...state, recording: true };
      // Still recording until the driver says it stopped.
      if (event.name === "stop_recording")
        return { ...state, stopping: new Set(state.stopping).add(event.id) };
      const window = targetOf(event.args);
      const capture = overlayCallCaptures(event.name, event.args);
      if (capture) {
        const snapshots =
          (event.name === "get_window_state" || event.name === "wait_for_window_settle") && window
            ? new Map(state.snapshots).set(event.id, window.windowId)
            : state.snapshots;
        return { ...state, capturing: new Set(state.capturing).add(event.id), snapshots };
      }
      if (!(event.name in INPUT_POINTS) || !window) return state;
      if (
        event.codeMode &&
        state.scoped !== undefined &&
        state.scoped.op !== "hide" &&
        (event.cursor?.owner === undefined ||
          (!sameOwner(state.scoped.identity, event.cursor.owner) &&
            event.cursor.owner.generation <= state.scoped.identity.generation))
      )
        return state;
      const supplied = event.cursor?.point ?? pointOf(state, event.name, args, window.windowId);
      const keepsTarget =
        supplied === undefined &&
        NON_SPATIAL_INPUTS.has(event.name) &&
        args?.element_token === undefined &&
        args?.from_zoom !== true &&
        args?.x === undefined &&
        args?.y === undefined &&
        state.target?.point !== undefined &&
        (event.codeMode
          ? !state.legacyTargetActive &&
            event.cursor?.owner !== undefined &&
            state.scoped?.op === "show" &&
            state.target.owner !== undefined &&
            sameAuthority(state.target.owner, event.cursor.owner)
          : state.legacyTargetActive && state.target.owner === undefined);
      const targetWindow = keepsTarget && state.target ? state.target : window;
      const point = supplied ?? (keepsTarget ? state.target?.point : undefined);
      return {
        ...state,
        scoped: event.codeMode
          ? callOwner(state, event.cursor?.owner, targetWindow, point)
          : state.scoped,
        target: {
          pid: targetWindow.pid,
          windowId: targetWindow.windowId,
          ...(point ? { point } : {}),
          ...(event.codeMode && event.cursor?.owner ? { owner: event.cursor.owner } : {}),
        },
        acting: new Set(state.acting).add(event.id),
        directActing: event.codeMode
          ? state.directActing
          : new Set(state.directActing).add(event.id),
        legacyTargetActive: event.codeMode !== true,
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
        directActing: without(state.directActing, event.id),
        capturing: without(state.capturing, event.id),
        stopping: without(state.stopping, event.id),
        recording: state.recording && !(state.stopping.has(event.id) && !event.failed),
        shots,
        snapshots,
      };
    }
    case "pause":
      return { ...state, pause: event.reason };
    case "end":
      return { ...state, ended: true };
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
