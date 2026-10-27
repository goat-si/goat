/**
 * Cua Driver calls that ask it to write a capture to a file (#1688). The agent could read that
 * file outside every check GOAT puts on screenshots: the window-only capture, the hidden overlay,
 * Private and Stop. So the lease proxy refuses them on every desktop before they reach the
 * driver, at any depth of their arguments (run_steps passes an observe step's arguments through)
 * and in a script's text, which can name them.
 */

/** Arguments that make the driver write pixels to a path (cua-driver-sdk remote_receiver.rs). */
const FILE_ARGUMENTS: ReadonlyArray<string> = ["screenshot_out_file", "image_path", "file_path"];

export const SCREENSHOT_FILE_REFUSED =
  "GOAT does not let Cua Driver write screenshots to a file; it shows the agent only captures it has checked. Call it without screenshot_out_file, image_path or file_path.";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function asksForFile(value: unknown): boolean {
  if (typeof value === "string") return FILE_ARGUMENTS.some((name) => value.includes(name));
  if (Array.isArray(value)) return value.some(asksForFile);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(
    ([key, item]) => (FILE_ARGUMENTS.includes(key) && item !== undefined) || asksForFile(item),
  );
}

/** Why a call's arguments cannot run, or undefined. */
export const refuseCaptureFileArguments = (args: unknown): string | undefined =>
  asksForFile(args) ? SCREENSHOT_FILE_REFUSED : undefined;
