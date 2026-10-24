import type {
  ComputerUseActionRequest,
  ComputerUseActionResult,
  ComputerUseElement,
  ComputerUseKey,
  ComputerUseObservation,
  ComputerUseRefusal,
  ComputerUseRefusalReason,
} from "@goat/contracts";
import { unsupportedComputerUseMethod } from "@goat/contracts";
import type { ObservationTracker } from "@goat/shared/computerUseObservation";

import type { DriverToolResult } from "./CuaDriverMcp.ts";

/**
 * Helper-protocol actions as Cua Driver 0.37.0 tool calls on Linux, and the driver's answers as
 * typed results (D5 in epic #1140).
 *
 * Nothing is sent unless every element ref resolves in the window's latest observation, pixel
 * points come from a screenshot in it, and no password field is the target or has focus. The
 * driver picks one route per call (an AT-SPI action, then real input from a virtual device) and
 * refuses background input it cannot deliver without focus instead of sending synthetic events,
 * so a background refusal here means nothing was sent.
 */

export interface LinuxActionContext {
  readonly observations: ObservationTracker;
  /** The latest observation's elements by ref, for roles and action names. */
  readonly elements: ReadonlyMap<string, ComputerUseElement>;
  /** A secure field has focus in the target's process, or focus could not be read (D6). */
  readonly privateMode: boolean;
  /** False on a Wayland session without XWayland: only AT-SPI actions reach a window unseen. */
  readonly pointerAndKeysInBackground: boolean;
}

export interface DriverCall {
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
}

const refusal = (reason: ComputerUseRefusalReason, message: string): ComputerUseRefusal => ({
  outcome: "refused",
  reason,
  message,
});

const PRIVATE = "A password field has focus. Wait for the person to leave it.";

/** Roles by modifier: option is Alt and command is Super on Linux. */
const MODIFIERS = { shift: "shift", control: "ctrl", option: "alt", command: "super" } as const;

/** Named keys in the driver's X11 key names; f13–f20 have none in 0.37.0. */
const NAMED_KEYS: Readonly<Record<string, string>> = {
  enter: "enter",
  tab: "tab",
  escape: "escape",
  backspace: "backspace",
  delete: "delete",
  space: "space",
  arrowUp: "up",
  arrowDown: "down",
  arrowLeft: "left",
  arrowRight: "right",
  home: "home",
  end: "end",
  pageUp: "pageup",
  pageDown: "pagedown",
  ...Object.fromEntries(
    Array.from({ length: 12 }, (_, index) => ["f" + (index + 1), "f" + (index + 1)]),
  ),
};

const driverKeyName = (key: ComputerUseKey): string | undefined =>
  // A printable key is one code point, which may be two UTF-16 units outside the BMP.
  [...key].length === 1 ? key : NAMED_KEYS[key];

const isSecureRole = (role: string | undefined) => role === "password text";

type Point = Extract<ComputerUseActionRequest, { action: "scroll" }>["at"];
type Located =
  | { readonly element_token: string; readonly role: string | undefined }
  | { readonly x: number; readonly y: number };

const isRefusal = (value: object): value is ComputerUseRefusal => "outcome" in value;

export function linuxDriverCall(
  request: ComputerUseActionRequest,
  context: LinuxActionContext,
): DriverCall | ComputerUseRefusal {
  if (context.privateMode) return refusal("privateMode", PRIVATE);
  const { pid, windowId } = request.target;
  const window = { pid, window_id: windowId, delivery_mode: request.delivery };
  const unsupported = (message: string) => ({
    ...unsupportedComputerUseMethod(request.action, "linux"),
    message,
  });

  const element = (ref: string) => {
    const resolved = context.observations.resolve({
      pid,
      windowId,
      observationId: request.observationId,
      element: ref,
    });
    if (!("token" in resolved)) return resolved;
    const role = context.elements.get(ref)?.role;
    if (isSecureRole(role)) return refusal("privateMode", "That element is a password field.");
    return { element_token: resolved.token, role, frame: resolved.frame };
  };
  const point = (x: number, y: number) => {
    const current = context.observations.pointsCurrent({
      pid,
      windowId,
      observationId: request.observationId,
    });
    return current === true ? { x, y } : current;
  };
  const locate = (at: Point): Located | ComputerUseRefusal => {
    if ("element" in at) {
      const resolved = element(at.element);
      return isRefusal(resolved)
        ? resolved
        : { element_token: resolved.element_token, role: resolved.role };
    }
    return point(at.x, at.y);
  };
  // Pointer and keyboard input without an element needs a background input device; on Wayland
  // without XWayland there is none, so it is refused here before anything is sent.
  const needsDevice = (located: Located | undefined) =>
    request.delivery === "background" &&
    !context.pointerAndKeysInBackground &&
    (located === undefined || !("element_token" in located))
      ? refusal(
          "backgroundUnavailable",
          "This Wayland session has no way to send pointer or key input to a window in the background. Use an element, or foreground delivery.",
        )
      : undefined;
  const args = (located: Located) =>
    "element_token" in located
      ? { element_token: located.element_token }
      : { x: located.x, y: located.y };
  const modifiers = (keys: ReadonlyArray<keyof typeof MODIFIERS> | undefined) =>
    keys && keys.length > 0 ? keys.map((key) => MODIFIERS[key]) : undefined;

  switch (request.action) {
    case "click":
    case "doubleClick":
    case "rightClick": {
      const at = locate(request.at);
      if (isRefusal(at)) return at;
      const blocked = needsDevice(at);
      if (blocked) return blocked;
      const modifier = modifiers(request.modifiers);
      return {
        tool: "click",
        args: {
          ...window,
          ...args(at),
          ...(request.action === "doubleClick" ? { count: 2 } : {}),
          ...(request.action === "rightClick" ? { button: "right" } : {}),
          ...(modifier ? { modifier } : {}),
        },
      };
    }
    case "typeText": {
      const at = request.at ? locate(request.at) : undefined;
      if (at && isRefusal(at)) return at;
      // Typing always goes through a keyboard device, whatever names the field.
      const blocked = needsDevice(undefined);
      if (blocked) return blocked;
      return {
        tool: "type_text",
        args: { ...window, ...(at ? args(at) : {}), text: request.text },
      };
    }
    case "pressKey": {
      const key = driverKeyName(request.key);
      if (key === undefined) return unsupported(request.key + " has no key on Linux X11 here.");
      const blocked = needsDevice(undefined);
      if (blocked) return blocked;
      const modifier = modifiers(request.modifiers);
      return modifier
        ? { tool: "hotkey", args: { ...window, keys: [...modifier, key] } }
        : { tool: "press_key", args: { ...window, key } };
    }
    case "scroll": {
      const at = locate(request.at);
      if (isRefusal(at)) return at;
      const blocked = needsDevice(at);
      if (blocked) return blocked;
      return {
        tool: "scroll",
        args: {
          ...window,
          ...args(at),
          direction: request.direction,
          amount: request.amount,
          by: "line",
        },
      };
    }
    case "drag": {
      // Drag takes pixels only, so an element is dragged from its frame's center.
      const pixel = (at: Point) => {
        if (!("element" in at)) return point(at.x, at.y);
        const resolved = element(at.element);
        if (isRefusal(resolved)) return resolved;
        if (!resolved.frame)
          return refusal("invalidRequest", "That element has no frame to drag from. Use a point.");
        return {
          x: resolved.frame.x + resolved.frame.width / 2,
          y: resolved.frame.y + resolved.frame.height / 2,
        };
      };
      const from = pixel(request.from);
      if (isRefusal(from)) return from;
      const to = pixel(request.to);
      if (isRefusal(to)) return to;
      const blocked = needsDevice(undefined);
      if (blocked) return blocked;
      return {
        tool: "drag",
        args: { ...window, from_x: from.x, from_y: from.y, to_x: to.x, to_y: to.y },
      };
    }
    case "setValue": {
      // Cua Driver 0.37.0 replaces a value; appending would need a driver patch.
      if (request.append) return unsupported("Appending to a value is not available on linux.");
      const resolved = element(request.element);
      if (isRefusal(resolved)) return resolved;
      // An AT-SPI EditableText or Value write, never input to the window.
      return {
        tool: "set_value",
        args: {
          pid,
          window_id: windowId,
          element_token: resolved.element_token,
          value: request.value,
        },
      };
    }
    case "performAction": {
      const resolved = element(request.element);
      if (isRefusal(resolved)) return resolved;
      // The driver's element click fires the element's first AT-SPI action and no other.
      const actions = context.elements.get(request.element)?.actions ?? [];
      if (actions[0] !== request.name)
        return unsupported(
          "Only an element's first action (" +
            (actions[0] ?? "none") +
            ") can be performed on linux.",
        );
      return { tool: "click", args: { ...window, element_token: resolved.element_token } };
    }
  }
}

/** Driver refusal codes and what each means to the agent. Unlisted codes are targetRefused. */
const REFUSAL_CODES: Readonly<Record<string, ComputerUseRefusalReason>> = {
  stale_element_token: "staleElement",
  point_outside_window: "staleElement",
  stale_geometry: "staleElement",
  px_frame_mismatch: "staleElement",
  screenshot_context_missing: "staleElement",
  window_id_not_found: "windowNotFound",
  window_not_found: "windowNotFound",
  window_target_not_found: "windowNotFound",
  window_target_resolution_failed: "windowNotFound",
  px_window_not_found: "windowNotFound",
  window_owner_pid_mismatch: "ownerMismatch",
  process_not_found: "targetGone",
  permission_denied: "permissionsNotGranted",
  background_unavailable: "backgroundUnavailable",
  target_occluded: "backgroundUnavailable",
  window_minimized: "backgroundUnavailable",
  wm_chord_unavailable: "backgroundUnavailable",
  foreground_unavailable: "targetRefused",
  invalid_arguments: "invalidRequest",
  invalid_action_target: "invalidRequest",
  window_id_required: "invalidRequest",
  driver_exited: "helperUnavailable",
  driver_error: "helperUnavailable",
  session_required: "helperUnavailable",
  session_not_started: "helperUnavailable",
  session_ended: "helperUnavailable",
  session_unavailable: "helperUnavailable",
};

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;

/** The driver's refusal code, at the top or under refusal. */
export const driverRefusalCode = (structured: unknown): string | undefined => {
  const code = field(structured, "code") ?? field(field(structured, "refusal"), "code");
  return typeof code === "string" ? code : undefined;
};

/**
 * Types the driver's answer to one action. after is the diff the helper read once the action
 * settled; undefined when it could not read one. Driver errors are refusals only when the
 * driver says nothing was sent; any other error after dispatch stays unverifiable.
 */
export function linuxActionResult(
  request: ComputerUseActionRequest,
  result: DriverToolResult,
  after: ComputerUseObservation | undefined,
): ComputerUseActionResult {
  const structured = result.structured;
  const code = driverRefusalCode(structured);
  const effect = field(structured, "effect");
  const detail = result.text.trim().split("\n", 1)[0] || undefined;
  if (
    field(structured, "status") === "refused" ||
    effect === "refused" ||
    (result.isError && code !== undefined)
  ) {
    const reason = code === undefined ? undefined : REFUSAL_CODES[code];
    return refusal(
      reason ?? "targetRefused",
      detail ?? "Cua Driver refused: " + (code ?? "no reason") + ".",
    );
  }
  const extra = {
    delivery: request.delivery,
    ...(detail === undefined ? {} : { detail }),
    ...(after === undefined ? {} : { observation: after }),
  };
  if (result.isError || effect === "partial")
    return {
      ...extra,
      outcome: result.isError ? "unverifiable" : "partial",
      dispatch: "dispatched_unknown",
    };
  if (effect === "confirmed") return { ...extra, outcome: "confirmed", dispatch: "verified" };
  if (effect === "suspected_noop" || effect === "not_applied" || effect === "no_drop")
    return { ...extra, outcome: "suspected_noop", dispatch: "verified" };
  // The driver could not tell; the helper's own diff after settling decides. A full read is not
  // comparable with what the agent saw, so it decides nothing.
  if (after === undefined || after.kind === "full")
    return { ...extra, outcome: "unverifiable", dispatch: "dispatched_unknown" };
  return after.added.length + after.changed.length + after.removed.length > 0
    ? { ...extra, outcome: "confirmed", dispatch: "verified" }
    : { ...extra, outcome: "suspected_noop", dispatch: "verified" };
}
