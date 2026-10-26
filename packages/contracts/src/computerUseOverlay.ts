/**
 * The agent cursor overlay (#1214). The per-connection macOS helper relays the driver's MCP
 * stdio (D3 amendment 2) and draws a click-through cursor and window glow. The server's lease
 * proxy decides what the overlay shows: it already sees every call, its reply and the control's
 * pauses. It sends that as a JSON-RPC notification on the helper's stdin. The helper applies it
 * and never forwards it to the driver.
 *
 * Ordering is the contract: a `hide` sent before a call line must be off screen before the
 * helper forwards that call. A capture the driver takes then cannot contain the overlay. Window
 * sharing flags do not provide this, because ScreenCaptureKit ignores them (#1321).
 *
 * @module computerUseOverlay
 */
import * as Schema from "effect/Schema";

/** The notification method the helper consumes; the driver never sees it. */
export const COMPUTER_USE_OVERLAY_METHOD = "goat/overlay";

const Fraction = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }));

/**
 * Where in the window the cursor sits, as a fraction of the screenshot the agent acted on. The
 * helper maps it onto the window's current on-screen frame, so screenshot scaling never matters.
 */
export const ComputerUseOverlayPoint = Schema.Struct({ fx: Fraction, fy: Fraction });
export type ComputerUseOverlayPoint = typeof ComputerUseOverlayPoint.Type;

/** Why nothing is drawn. Every reason hides the cursor and the glow alike. */
export const ComputerUseOverlayHideReason = Schema.Literals([
  "idle",
  "capture",
  "human_input",
  "takeover",
  "private",
  "ended",
]);
export type ComputerUseOverlayHideReason = typeof ComputerUseOverlayHideReason.Type;

export const ComputerUseOverlayCommand = Schema.Union([
  Schema.Struct({
    op: Schema.Literal("show"),
    pid: Schema.Int,
    windowId: Schema.Int,
    /** Absent when the call named an element, a zoomed region or a window not yet seen. */
    point: Schema.optionalKey(ComputerUseOverlayPoint),
    /** "acting" while an input call is in flight; "resting" after it answered. */
    phase: Schema.Literals(["acting", "resting"]),
  }),
  Schema.Struct({ op: Schema.Literal("hide"), reason: ComputerUseOverlayHideReason }),
]);
export type ComputerUseOverlayCommand = typeof ComputerUseOverlayCommand.Type;

/**
 * Where the agent's cursor is on the window a live picture shows, for previews that draw it
 * over the frame like the helper draws it on screen. Fractions of the window, as in the overlay.
 */
export const ComputerUseAgentCursor = Schema.Struct({
  windowId: Schema.Int,
  point: ComputerUseOverlayPoint,
  phase: Schema.Literals(["acting", "resting"]),
});
export type ComputerUseAgentCursor = typeof ComputerUseAgentCursor.Type;
