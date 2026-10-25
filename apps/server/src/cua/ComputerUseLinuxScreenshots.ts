// @effect-diagnostics preferSchemaOverJson:off -- Driver replies pass through as JSON-RPC lines; only their image blocks are rewritten.
import * as Effect from "effect/Effect";

import { type CaptureRoute, driverShot, waylandCaptureRoute } from "./linuxHelper/windowCapture.ts";
import { captureX11Window } from "./linuxHelper/x11WindowCapture.ts";

/**
 * What an agent's screenshots may show on Linux (#1677). The Linux helper already keeps every
 * window screenshot to the window's own pixels (windowCapture.ts, #1328); calls that go straight
 * to Cua Driver through the lease proxy follow the same route here, so the agent never gets a
 * picture GOAT could not vouch for:
 *
 * - X11 and XWayland: a window read's image is replaced by GOAT's own capture, which asks the app
 *   to redraw and refuses when it does not. Cua Driver's own capture reads the composite pixmap
 *   as it is, so while the screen is locked (and the compositor paints nothing) it hands back
 *   the last frame the window drew. Images from any other call cannot be checked that way and
 *   are withheld.
 * - Wayland on Hyprland: the driver exports the window itself, so its image is kept.
 * - Any other Wayland compositor: the driver crops the whole screen, so images are withheld.
 *
 * A withheld image becomes a line of text saying why; the rest of the result is kept.
 */

/** Calls whose image is one window's screenshot, taken at the size in their structured result. */
const WINDOW_READS: ReadonlySet<string> = new Set(["get_window_state", "wait_for_window_settle"]);

export const UNVERIFIED_IMAGE =
  "On this desktop GOAT shows an agent only a window's own capture, and this result's image is not one. Read the window with get_window_state to see it.";

export interface DriverReply {
  readonly tool: string | undefined;
  /** The window the call named, when it named one. */
  readonly windowId: number | undefined;
  readonly line: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isImage = (block: unknown) => isRecord(block) && block.type === "image";

/** The window_id a tools/call names, when it names one. */
export function windowArgument(args: unknown): { readonly windowId?: number } {
  const value = isRecord(args) ? args.window_id : undefined;
  return typeof value === "number" ? { windowId: value } : {};
}

/** The route the lease proxy's driver captures by, from the display GOAT gave it. */
export function proxyCaptureRoute(options: {
  readonly x11Display: { readonly DISPLAY: string; readonly XAUTHORITY?: string } | undefined;
  readonly driverEnvironment: Readonly<Record<string, string | undefined>>;
}): CaptureRoute {
  const display = options.x11Display;
  if (display !== undefined)
    return {
      route: "own",
      capture: (windowId, shot) => captureX11Window(display, windowId, shot),
    };
  return waylandCaptureRoute(options.driverEnvironment);
}

/** Returns the reply line to deliver: its images kept, replaced by GOAT's own, or withheld. */
export const admitLinuxScreenshots = (route: CaptureRoute) =>
  Effect.fn("ComputerUseLinuxScreenshots.admit")(function* (reply: DriverReply) {
    if (route.route === "driver") return reply.line;
    let message: unknown;
    try {
      message = JSON.parse(reply.line);
    } catch {
      return reply.line;
    }
    const result = isRecord(message) ? message.result : undefined;
    if (!isRecord(message) || !isRecord(result) || !Array.isArray(result.content))
      return reply.line;
    const content: ReadonlyArray<unknown> = result.content;
    if (!content.some(isImage)) return reply.line;
    const deliver = (blocks: ReadonlyArray<unknown>, withheld: boolean) => {
      const structured = result.structuredContent;
      const kept =
        withheld && isRecord(structured)
          ? Object.fromEntries(
              Object.entries(structured).filter(([key]) => !key.startsWith("screenshot_")),
            )
          : structured;
      return JSON.stringify({
        ...message,
        result: {
          ...result,
          content: blocks,
          ...(kept === undefined ? {} : { structuredContent: kept }),
        },
      });
    };
    const withhold = (reason: string) =>
      deliver(
        content.map((block) =>
          isImage(block)
            ? { type: "text", text: "GOAT withheld a screenshot from this result. " + reason }
            : block,
        ),
        true,
      );
    if (route.route === "refused") return withhold(route.reason);
    const shot = driverShot(result.structuredContent);
    if (reply.tool === undefined || !WINDOW_READS.has(reply.tool) || reply.windowId === undefined)
      return withhold(UNVERIFIED_IMAGE);
    if (shot === undefined) return withhold(UNVERIFIED_IMAGE);
    const windowId = reply.windowId;
    const own = yield* Effect.promise(() =>
      route.capture(windowId, shot).catch(() => ({ refused: UNVERIFIED_IMAGE })),
    );
    if ("refused" in own) return withhold(own.refused);
    let replaced = false;
    return deliver(
      content.map((block) => {
        if (!isImage(block)) return block;
        if (replaced)
          return {
            type: "text",
            text: "GOAT withheld a screenshot from this result. " + UNVERIFIED_IMAGE,
          };
        replaced = true;
        return {
          type: "image",
          mimeType: "image/png",
          data: Buffer.from(own.png).toString("base64"),
        };
      }),
      false,
    );
  });
