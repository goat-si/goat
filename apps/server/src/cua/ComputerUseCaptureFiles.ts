// An agent could read a capture file outside every screenshot check (window-only capture, overlay
// hide, Private, Stop), so the proxy refuses these on every desktop: at any depth, since run_steps
// passes an observe step's arguments through, and in run_script's source, which can name them.
// Other text (typed text, a query) only mentions a name and cannot ask for a file.

/** Arguments that make the driver write pixels to a path (cua-driver-sdk remote_receiver.rs). */
const FILE_ARGUMENTS: ReadonlyArray<string> = ["screenshot_out_file", "image_path", "file_path"];

export const SCREENSHOT_FILE_REFUSED =
  "GOAT does not let Cua Driver write screenshots to a file; it shows the agent only captures it has checked. Call it without screenshot_out_file, image_path or file_path.";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function asksForFile(value: unknown, script = false): boolean {
  if (typeof value === "string")
    return script && FILE_ARGUMENTS.some((name) => value.includes(name));
  if (Array.isArray(value)) return value.some((item) => asksForFile(item, script));
  if (!isRecord(value)) return false;
  return Object.entries(value).some(
    ([key, item]) =>
      (FILE_ARGUMENTS.includes(key) && item !== undefined) || asksForFile(item, key === "script"),
  );
}

/** Why a call's arguments cannot run, or undefined. */
export const refuseCaptureFileArguments = (args: unknown): string | undefined =>
  asksForFile(args) ? SCREENSHOT_FILE_REFUSED : undefined;
