// @effect-diagnostics nodeBuiltinImport:off -- The Linux helper is its own Node process; it reads /proc to check who owns a bus name.
import * as NodeFSP from "node:fs/promises";

import type { GdbusRunner } from "./atspiFocus.ts";
import type { LinuxSession } from "./linuxSession.ts";

/**
 * Whether Cua Driver can capture one window's own pixels on this desktop (#1328). On X11 and
 * XWayland it reads the window itself. On Wayland, pinned 0.37.0 does so only on Hyprland and
 * through its GNOME Shell helper from API 9; anywhere else it crops a capture of the whole
 * output to the window's bounds, so a window covering it shows in the crop. The helper then
 * asks for no screenshot at all.
 *
 * The GNOME check mirrors the driver's own (platform-linux wayland/shell_helper.rs at
 * cua-driver-rs-v0.37.0): the name's owner must be this user's root-owned gnome-shell, at API 9
 * or later. If the driver would not trust the helper, neither does this.
 *
 * Answers undefined when a window capture is the window's own, or why it is not.
 */
export type WindowCaptureCheck = () => Promise<string | undefined>;

export const CROPPED_CAPTURE =
  "This Wayland desktop cannot capture one window by itself: Cua Driver would crop a capture of the whole screen, which can show other apps' windows. Screenshots are off here; app controls still work. Hyprland, GNOME with Cua Driver's GNOME Shell helper (API 9 or later), or an X11 session can show GOAT a single window.";

const HELPER_NAME = "org.cua.WinRects";
const HELPER_PATH = "/org/cua/WinRects";
const WINDOW_CAPTURE_API = 9;

/** What the GNOME check reads about a process, from /proc. */
export interface ProcessFacts {
  readonly comm: string;
  readonly executable: string;
  readonly executableOwner: number;
  readonly executableMode: number;
}

export const readProcessFacts = async (pid: number): Promise<ProcessFacts | undefined> => {
  try {
    const comm = await NodeFSP.readFile("/proc/" + pid + "/comm", "utf8");
    const executable = await NodeFSP.readlink("/proc/" + pid + "/exe");
    const stat = await NodeFSP.stat(executable);
    return { comm: comm.trim(), executable, executableOwner: stat.uid, executableMode: stat.mode };
  } catch {
    return undefined;
  }
};

const quoted = (raw: string) => /'([^']+)'/u.exec(raw)?.[1];
// gdbus prints typed scalars as `(uint32 6079,)`; the type's own digits are not the value.
const firstUint = (raw: string) => {
  const match = /\d+/u.exec(raw.split("uint32").at(-1) ?? raw);
  return match ? Number(match[0]) : undefined;
};

export function makeWindowCaptureCheck(deps: {
  readonly session: LinuxSession;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly gdbus: GdbusRunner;
  readonly processFacts: (pid: number) => Promise<ProcessFacts | undefined>;
  readonly uid: number;
}): WindowCaptureCheck {
  if (deps.session.displayServer !== "wayland") return async () => undefined;
  // The driver captures a Hyprland toplevel through its export, or refuses; it never crops.
  if ((deps.environment.HYPRLAND_INSTANCE_SIGNATURE ?? "") !== "") return async () => undefined;
  const bus = (method: string, args: ReadonlyArray<string>) =>
    deps.gdbus([
      "call",
      "--session",
      "--dest",
      "org.freedesktop.DBus",
      "--object-path",
      "/org/freedesktop/DBus",
      "--method",
      "org.freedesktop.DBus." + method,
      ...args,
    ]);
  const gnomeHelper = async () => {
    const owner = quoted(await bus("GetNameOwner", [HELPER_NAME]));
    if (!owner?.startsWith(":")) return false;
    const pid = firstUint(await bus("GetConnectionUnixProcessID", [owner]));
    const uid = firstUint(await bus("GetConnectionUnixUser", [owner]));
    if (pid === undefined || uid !== deps.uid) return false;
    const facts = await deps.processFacts(pid);
    if (
      !facts ||
      facts.comm !== "gnome-shell" ||
      !facts.executable.endsWith("/gnome-shell") ||
      facts.executableOwner !== 0 ||
      (facts.executableMode & 0o022) !== 0
    )
      return false;
    const version = firstUint(
      await deps.gdbus([
        "call",
        "--session",
        "--dest",
        owner,
        "--object-path",
        HELPER_PATH,
        "--method",
        HELPER_NAME + ".GetVersion",
      ]),
    );
    return version !== undefined && version >= WINDOW_CAPTURE_API;
  };
  return async () => ((await gnomeHelper().catch(() => false)) ? undefined : CROPPED_CAPTURE);
}
