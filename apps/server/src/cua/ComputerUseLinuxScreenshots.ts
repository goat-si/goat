// @effect-diagnostics preferSchemaOverJson:off -- Driver replies pass through as JSON-RPC lines; only their images are rewritten.
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
 *   the last frame the window drew. Images anywhere else cannot be checked that way and are
 *   withheld.
 * - Wayland on Hyprland: the driver exports the window itself, so its images are kept.
 * - Any other Wayland compositor, or a driver whose display GOAT cannot place: images are
 *   withheld.
 *
 * Withholding fails closed: every driver line is read, not just a tool result's top-level image
 * blocks, and anything that looks like image data (an image block, a resource blob, a data: URL
 * or base64 PNG/JPEG/GIF/WebP bytes, including inside text) becomes a line of text saying why.
 * Calls that ask the driver to write its capture to a file are refused before they run, since
 * the agent could read the file without any of this.
 */

/** Calls whose image is one window's screenshot, taken at the size in their structured result. */
const WINDOW_READS: ReadonlySet<string> = new Set(["get_window_state", "wait_for_window_settle"]);

/** Arguments that make the driver write pixels to a path (cua-driver-sdk remote_receiver.rs). */
const FILE_ARGUMENTS: ReadonlyArray<string> = ["screenshot_out_file", "image_path", "file_path"];

export const UNVERIFIED_IMAGE =
  "On this desktop GOAT shows an agent only a window's own capture, and this result's image is not one. Read the window with get_window_state to see it.";

export const SCREENSHOT_FILE_REFUSED =
  "On this desktop GOAT does not let Cua Driver write screenshots to a file; it shows the agent only a window's own capture, checked first. Call it without screenshot_out_file, image_path or file_path.";

const WITHHELD = "GOAT withheld a screenshot from this result. ";

// Base64 of PNG, JPEG, GIF and RIFF (WebP) headers, and data: image URLs, as written or with the
// slashes JSON may escape.
const IMAGE_TEXT = /data:image(?:\/|\\\/)|iVBORw0KGgo|(?:\/|\\\/)9j(?:\/|\\\/)|R0lGOD[dl]h|UklGR/;

export interface DriverReply {
  readonly tool?: string;
  /** The window the call named, when it named one. */
  readonly windowId?: number;
  readonly line: string;
}

export interface LinuxScreenshotPolicy {
  /** A tools/call reply as delivered: its window image kept, replaced by GOAT's own, or withheld. */
  readonly admit: (reply: DriverReply) => Effect.Effect<string>;
  /** Any other driver line as delivered, with anything image-like withheld. */
  readonly scrub: (line: string) => string;
  /** Why a call's arguments cannot run, or undefined. */
  readonly refuseArguments: (args: unknown) => string | undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isImage = (block: unknown) => isRecord(block) && block.type === "image";

const parse = (line: string): unknown => {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
};

/** value with everything image-like replaced by text saying why; keep is delivered as is. */
function withhold(value: unknown, reason: string, keep?: unknown): unknown {
  if (value === keep && keep !== undefined) return value;
  if (typeof value === "string") return IMAGE_TEXT.test(value) ? WITHHELD + reason : value;
  if (Array.isArray(value)) return value.map((item) => withhold(item, reason, keep));
  if (!isRecord(value)) return value;
  if (isImage(value)) return { type: "text", text: WITHHELD + reason };
  const mimeType = typeof value.mimeType === "string" ? value.mimeType.toLowerCase() : "";
  if (value.blob !== undefined && !mimeType.startsWith("text/")) {
    const { blob: _blob, ...rest } = value;
    return { ...rest, mimeType: "text/plain", text: WITHHELD + reason };
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, withhold(item, reason, keep)]),
  );
}

/** The window_id a tools/call names, when it names one. */
export function windowArgument(args: unknown): { readonly windowId?: number } {
  const value = isRecord(args) ? args.window_id : undefined;
  return typeof value === "number" ? { windowId: value } : {};
}

/**
 * The route the lease proxy's driver captures by, from the display GOAT gave it. A driver with an
 * X display GOAT did not place could be capturing anything, so it is refused.
 */
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
  if ((options.driverEnvironment.DISPLAY ?? "").trim() !== "")
    return { route: "refused", reason: UNVERIFIED_IMAGE };
  return waylandCaptureRoute(options.driverEnvironment);
}

export function linuxScreenshotPolicy(route: CaptureRoute): LinuxScreenshotPolicy {
  const reasonFor = route.route === "refused" ? route.reason : UNVERIFIED_IMAGE;
  const scrub = (line: string) => {
    if (route.route === "driver") return line;
    const message = parse(line);
    if (message === undefined)
      return IMAGE_TEXT.test(line)
        ? JSON.stringify({
            jsonrpc: "2.0",
            method: "notifications/message",
            params: { level: "warning", data: WITHHELD + reasonFor },
          })
        : line;
    const scrubbed = withhold(message, reasonFor);
    return JSON.stringify(scrubbed) === JSON.stringify(message) ? line : JSON.stringify(scrubbed);
  };

  const admit = Effect.fn("ComputerUseLinuxScreenshots.admit")(function* (reply: DriverReply) {
    if (route.route === "driver") return reply.line;
    const message = parse(reply.line);
    const result = isRecord(message) ? message.result : undefined;
    if (
      route.route !== "own" ||
      !isRecord(message) ||
      !isRecord(result) ||
      !Array.isArray(result.content) ||
      !result.content.some(isImage)
    )
      return scrub(reply.line);
    const shot = driverShot(result.structuredContent);
    const windowId = reply.windowId;
    let reason = UNVERIFIED_IMAGE;
    let own: Record<string, unknown> | undefined;
    if (
      reply.tool !== undefined &&
      WINDOW_READS.has(reply.tool) &&
      windowId !== undefined &&
      shot !== undefined
    ) {
      const captured = yield* Effect.promise(() =>
        route.capture(windowId, shot).catch(() => ({ refused: UNVERIFIED_IMAGE })),
      );
      if ("refused" in captured) reason = captured.refused;
      else
        own = {
          type: "image",
          mimeType: "image/png",
          data: Buffer.from(captured.png).toString("base64"),
        };
    }
    let placed = false;
    const content = result.content.map((block: unknown) => {
      if (!isImage(block) || own === undefined || placed) return block;
      placed = true;
      return own;
    });
    // GOAT's capture is delivered at the driver's screenshot size, as a PNG; without one, the
    // screenshot's description goes with it.
    const structured = result.structuredContent;
    const described = !isRecord(structured)
      ? structured
      : own !== undefined
        ? "screenshot_mime_type" in structured
          ? { ...structured, screenshot_mime_type: "image/png" }
          : structured
        : Object.fromEntries(
            Object.entries(structured).filter(([key]) => !key.startsWith("screenshot_")),
          );
    return JSON.stringify(
      withhold(
        {
          ...message,
          result: {
            ...result,
            content,
            ...(described === undefined ? {} : { structuredContent: described }),
          },
        },
        reason,
        own,
      ),
    );
  });

  const refuseArguments = (args: unknown) =>
    isRecord(args) && FILE_ARGUMENTS.some((name) => args[name] !== undefined)
      ? SCREENSHOT_FILE_REFUSED
      : undefined;

  return { admit, scrub, refuseArguments };
}
