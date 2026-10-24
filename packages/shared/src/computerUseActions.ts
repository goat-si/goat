import type {
  ComputerUseActionRequest,
  ComputerUseActionResult,
  ComputerUseKey,
  ComputerUseRefusal,
  ComputerUseRefusalReason,
} from "@goat/contracts";

import type { ObservationTracker } from "./computerUseObservation.ts";

/**
 * Turns helper-protocol actions into Cua Driver 0.37.0 tool calls on one exact window, and the
 * driver's answers into D5 results (epoch #1140).
 *
 * Nothing is sent unless the target is pinned to a pid and window, every element ref resolves in
 * the current lineage, pixel points come from the latest screenshot, no secure field has focus,
 * and foreground delivery is something the lease allows. An answer the driver does not classify
 * is unverifiable, never confirmed, so the caller observes again instead of repeating input.
 */

export interface ActionContext {
  readonly observations: ObservationTracker;
  /** The control lease allows raising the window (D5, D7). */
  readonly foregroundAllowed: boolean;
  /** A secure field has focus in the target window (D6). */
  readonly privateMode: boolean;
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

const MODIFIERS = { shift: "shift", control: "ctrl", option: "option", command: "cmd" } as const;

/** AX action names the driver's click accepts through its action argument. */
const AX_ACTIONS: Readonly<Record<string, string>> = {
  AXPress: "press",
  AXShowMenu: "show_menu",
  AXPick: "pick",
  AXConfirm: "confirm",
  AXCancel: "cancel",
  AXOpen: "open",
  AXShowAlternateUI: "show_alternate_ui",
  AXShowDefaultUI: "show_default_ui",
};

type Point = Extract<ComputerUseActionRequest, { action: "scroll" }>["at"];

/** Named keys as Cua Driver 0.37.0's press_key spells them on mac. */
const NAMED_KEYS: Readonly<Record<string, string>> = {
  enter: "return",
  tab: "tab",
  escape: "escape",
  // The Mac key labeled delete erases backwards; the driver names no forward delete.
  backspace: "delete",
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
    Array.from({ length: 12 }, (_, index) => [`f${index + 1}`, `f${index + 1}`]),
  ),
};

/** The driver's name for a protocol key, or undefined when this driver cannot press it. */
function driverKey(key: ComputerUseKey): string | undefined {
  if (/^[a-z0-9]$/u.test(key)) return key;
  if (/^[A-Z]$/u.test(key)) return key.toLowerCase();
  return NAMED_KEYS[key];
}

export function driverCallFor(
  request: ComputerUseActionRequest,
  context: ActionContext,
): DriverCall | ComputerUseRefusal {
  if (context.privateMode)
    return refusal("privateMode", "A password field has focus. Wait for the person to leave it.");
  if (request.delivery === "foreground" && !context.foregroundAllowed)
    return refusal(
      "foregroundNotAllowed",
      "Raising this window needs a control lease that allows foreground input.",
    );
  const { pid, windowId } = request.target;
  // Every action, keyboard input included, is for the window as the agent last saw it.
  const confirmed = context.observations.confirm({
    pid,
    windowId,
    observationId: request.observationId,
    epoch: request.target.epoch,
  });
  if (confirmed !== true) return confirmed;
  const window = { pid, window_id: windowId, delivery_mode: request.delivery };

  // An element becomes its current driver token; a point must come from the latest screenshot.
  const locate = (
    at: Point,
  ):
    | { readonly element_token: string }
    | { readonly x: number; readonly y: number }
    | ComputerUseRefusal => {
    if ("element" in at) {
      const resolved = context.observations.resolve({
        pid,
        windowId,
        observationId: request.observationId,
        element: at.element,
      });
      return "token" in resolved ? { element_token: resolved.token } : resolved;
    }
    const current = context.observations.pointsCurrent({
      pid,
      windowId,
      observationId: request.observationId,
    });
    return current === true ? { x: at.x, y: at.y } : current;
  };
  // Drag takes pixels only, so an element is dragged from its frame's center.
  const pixel = (at: Point): { readonly x: number; readonly y: number } | ComputerUseRefusal => {
    if (!("element" in at)) {
      const current = context.observations.pointsCurrent({
        pid,
        windowId,
        observationId: request.observationId,
      });
      return current === true ? { x: at.x, y: at.y } : current;
    }
    const resolved = context.observations.resolve({
      pid,
      windowId,
      observationId: request.observationId,
      element: at.element,
    });
    if (!("token" in resolved)) return resolved;
    if (!resolved.frame)
      return refusal("invalidRequest", "That element has no frame to drag from. Use a point.");
    return {
      x: resolved.frame.x + resolved.frame.width / 2,
      y: resolved.frame.y + resolved.frame.height / 2,
    };
  };
  const isRefusal = (value: object): value is ComputerUseRefusal => "outcome" in value;
  const modifiers = (keys: ReadonlyArray<keyof typeof MODIFIERS> | undefined) =>
    keys && keys.length > 0 ? keys.map((key) => MODIFIERS[key]) : undefined;

  switch (request.action) {
    case "click":
    case "doubleClick":
    case "rightClick": {
      const at = locate(request.at);
      if (isRefusal(at)) return at;
      const modifier = modifiers(request.modifiers);
      if (modifier && request.action === "doubleClick")
        return refusal("invalidRequest", "A double click cannot carry modifier keys here.");
      return {
        tool: { click: "click", doubleClick: "double_click", rightClick: "right_click" }[
          request.action
        ],
        args: { ...window, ...at, ...(modifier ? { modifier } : {}) },
      };
    }
    case "typeText": {
      const at = request.at ? locate(request.at) : {};
      if (isRefusal(at)) return at;
      return { tool: "type_text", args: { ...window, ...at, text: request.text } };
    }
    case "pressKey": {
      const key = driverKey(request.key);
      if (key === undefined)
        return {
          ...refusal("unsupported", `The key ${request.key} cannot be pressed on mac.`),
          method: "pressKey",
          platform: "mac",
        };
      // An uppercase letter is its key with shift, as the contract names keys unmodified.
      const shifted = key !== request.key && /^[A-Z]$/u.test(request.key);
      const modifier = modifiers(
        shifted ? [...(request.modifiers ?? []), "shift"] : request.modifiers,
      );
      return {
        tool: "press_key",
        args: { ...window, key, ...(modifier ? { modifiers: [...new Set(modifier)] } : {}) },
      };
    }
    case "scroll": {
      const at = locate(request.at);
      if (isRefusal(at)) return at;
      return {
        tool: "scroll",
        args: { ...window, ...at, direction: request.direction, amount: request.amount },
      };
    }
    case "drag": {
      const from = pixel(request.from);
      if (isRefusal(from)) return from;
      const to = pixel(request.to);
      if (isRefusal(to)) return to;
      return {
        tool: "drag",
        args: { ...window, from_x: from.x, from_y: from.y, to_x: to.x, to_y: to.y },
      };
    }
    case "setValue": {
      // Cua Driver 0.37.0 replaces the value; appending would need a driver patch.
      if (request.append)
        return {
          ...refusal("unsupported", "Appending to a value is not available on mac."),
          method: "setValue",
          platform: "mac",
        };
      const at = locate({ element: request.element });
      if (isRefusal(at)) return at;
      // set_value has no delivery mode: it is an accessibility write, never input to a window.
      return { tool: "set_value", args: { pid, window_id: windowId, ...at, value: request.value } };
    }
    case "performAction": {
      // Own keys only: an inherited name such as toString must not slip through as an action.
      const action = Object.hasOwn(AX_ACTIONS, request.name) ? AX_ACTIONS[request.name] : undefined;
      if (!action)
        return {
          ...refusal(
            "unsupported",
            request.name + " is not an action the driver can perform on mac.",
          ),
          method: "performAction",
          platform: "mac",
        };
      const at = locate({ element: request.element });
      if (isRefusal(at)) return at;
      return { tool: "click", args: { ...window, ...at, action } };
    }
  }
}

/** Driver refusal codes and what each means to the agent. Unlisted codes are targetRefused. */
/**
 * Codes the pinned macOS driver emits only before any input leaves: snapshot and frame
 * admission, window lookup, argument and session checks (located in its source by review).
 * foreground_unavailable is not here: a foreground click can post mouse-down and then fail on
 * mouse-up. background_unavailable is not here either: a drag reports it after starting. With no
 * explicit refused effect those stay unverifiable.
 */
const PRE_DISPATCH_CODES: ReadonlySet<string> = new Set([
  "stale_element_token",
  "screenshot_context_missing",
  "px_frame_mismatch",
  "px_window_not_found",
  "window_id_not_found",
  "window_owner_pid_mismatch",
  "window_target_not_found",
  "window_target_resolution_failed",
  "permission_denied",
  "invalid_arguments",
  "invalid_action_target",
  "select_menu_would_raise_window",
  "window_id_required",
  "session_required",
  "session_not_started",
  "session_ended",
  "session_unavailable",
  "transport_lease_required",
]);

const REFUSAL_CODES: Readonly<Record<string, ComputerUseRefusalReason>> = {
  stale_element_token: "staleElement",
  point_outside_window: "staleElement",
  stale_geometry: "staleElement",
  px_frame_mismatch: "staleElement",
  screenshot_context_missing: "staleElement",
  window_id_not_found: "windowNotFound",
  window_target_not_found: "windowNotFound",
  window_target_resolution_failed: "windowNotFound",
  px_window_not_found: "windowNotFound",
  window_owner_pid_mismatch: "ownerMismatch",
  permission_denied: "permissionsNotGranted",
  background_unavailable: "backgroundUnavailable",
  select_menu_would_raise_window: "backgroundUnavailable",
  target_occluded: "backgroundUnavailable",
  window_minimized: "backgroundUnavailable",
  foreground_unavailable: "backgroundUnavailable",
  invalid_arguments: "invalidRequest",
  invalid_action_target: "invalidRequest",
  window_id_required: "invalidRequest",
  session_required: "helperUnavailable",
  session_not_started: "helperUnavailable",
  session_ended: "helperUnavailable",
  session_unavailable: "helperUnavailable",
  transport_lease_required: "helperUnavailable",
};

export interface DriverToolResult {
  readonly isError: boolean;
  readonly text: string;
  readonly structured: unknown;
}

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;

/**
 * Reads the driver's answer to one action. A result is confirmed only when the driver says so;
 * an error after input may have been sent stays unverifiable so nothing replays it.
 */
export function actionResultFromDriver(
  request: ComputerUseActionRequest,
  result: DriverToolResult,
): ComputerUseActionResult {
  // Two envelopes: { effect, code } from input tools, and { status: "refused", refusal: { code } }
  // from the snapshot store (stale tokens).
  const nested = field(result.structured, "refusal");
  const refusedByStatus = field(result.structured, "status") === "refused";
  const effect = refusedByStatus ? "refused" : field(result.structured, "effect");
  const code = field(nested, "code") ?? field(result.structured, "code");
  const detail = result.text.trim().split("\n", 1)[0] || undefined;
  const sent = { delivery: request.delivery, ...(detail === undefined ? {} : { detail }) };
  const known =
    typeof code === "string" && Object.hasOwn(REFUSAL_CODES, code)
      ? REFUSAL_CODES[code]
      : undefined;
  const beforeInput = typeof code === "string" && PRE_DISPATCH_CODES.has(code);
  // A refusal says nothing was sent, so it needs the driver's word for it: an explicit refused
  // effect, or an error code that only fires before input leaves. Any other error, such as
  // delivery_failed after a key went down, may have landed and stays unverifiable.
  if (effect === "refused" || (beforeInput && effect === undefined && result.isError)) {
    return refusal(
      known ?? "targetRefused",
      detail ??
        (typeof code === "string" ? "The driver refused: " + code + "." : "The driver refused."),
    );
  }
  switch (effect) {
    case "confirmed":
      return { ...sent, outcome: "confirmed", dispatch: "verified" };
    case "partial":
      return { ...sent, outcome: "partial", dispatch: "dispatched_unknown" };
    // The driver saw the target and nothing changed: a drag no window accepted, a value the
    // control did not take.
    case "suspected_noop":
    case "no_drop":
    case "not_applied":
      return { ...sent, outcome: "suspected_noop", dispatch: "verified" };
    default:
      return { ...sent, outcome: "unverifiable", dispatch: "dispatched_unknown" };
  }
}
