import { describe, expect, it } from "vite-plus/test";

import { detectLinuxSession } from "./linuxSession.ts";
import { CROPPED_CAPTURE, makeWindowCaptureCheck, type ProcessFacts } from "./windowCapture.ts";

const SESSION = {
  display: undefined,
  waylandDisplay: "wayland-0",
  sessionBus: "unix:path=/run/user/1000/bus",
  currentDesktop: "GNOME",
  gnomeShellMajor: 46,
};
const SHELL: ProcessFacts = {
  comm: "gnome-shell",
  executable: "/usr/bin/gnome-shell",
  executableOwner: 0,
  executableMode: 0o100755,
};

/** A session bus where GNOME Shell (pid 900, uid 1000) owns the Cua helper at this API. */
function check(
  options: {
    readonly x11?: boolean;
    readonly environment?: Record<string, string>;
    readonly version?: number;
    readonly owner?: string;
    readonly ownerUid?: number;
    readonly shell?: ProcessFacts | undefined;
    readonly busFails?: boolean;
  } = {},
) {
  const calls: string[][] = [];
  const windowCapture = makeWindowCaptureCheck({
    session: detectLinuxSession(options.x11 ? { ...SESSION, display: ":0" } : SESSION),
    environment: options.environment ?? {},
    uid: 1000,
    processFacts: async (pid) =>
      pid === 900 ? ("shell" in options ? options.shell : SHELL) : undefined,
    gdbus: async (args) => {
      calls.push([...args]);
      if (options.busFails) throw new Error("no session bus");
      const method = args[args.indexOf("--method") + 1];
      if (method === "org.freedesktop.DBus.GetNameOwner")
        return "('" + (options.owner ?? ":1.42") + "',)\n";
      if (method === "org.freedesktop.DBus.GetConnectionUnixProcessID") return "(uint32 900,)\n";
      if (method === "org.freedesktop.DBus.GetConnectionUnixUser")
        return "(uint32 " + (options.ownerUid ?? 1000) + ",)\n";
      if (method === "org.cua.WinRects.GetVersion")
        return "(uint32 " + (options.version ?? 9) + ",)\n";
      throw new Error("unexpected " + method);
    },
  });
  return { windowCapture, calls };
}

describe("window capture on Linux (#1328)", () => {
  it("X11 and Hyprland capture the window itself, without asking the bus", async () => {
    const x11 = check({ x11: true });
    expect(await x11.windowCapture()).toBeUndefined();
    const hyprland = check({ environment: { HYPRLAND_INSTANCE_SIGNATURE: "abc_123" } });
    expect(await hyprland.windowCapture()).toBeUndefined();
    expect([...x11.calls, ...hyprland.calls]).toEqual([]);
  });

  it("GNOME captures one window only through its Shell helper at API 9 or later", async () => {
    expect(await check({ version: 9 }).windowCapture()).toBeUndefined();
    expect(await check({ version: 10 }).windowCapture()).toBeUndefined();
    expect(await check({ version: 8 }).windowCapture()).toBe(CROPPED_CAPTURE);
  });

  it("a helper the driver would not trust counts as none, so the capture would be cropped", async () => {
    const untrusted = [
      check({ owner: "org.cua.WinRects" }),
      check({ ownerUid: 1001 }),
      check({ shell: undefined }),
      check({ shell: { ...SHELL, comm: "python3" } }),
      check({ shell: { ...SHELL, executable: "/home/user/gnome-shell-copy" } }),
      check({ shell: { ...SHELL, executableOwner: 1000 } }),
      check({ shell: { ...SHELL, executableMode: 0o100775 } }),
      // No helper owns the name at all, as on sway or KDE.
      check({ busFails: true }),
    ];
    for (const { windowCapture } of untrusted) expect(await windowCapture()).toBe(CROPPED_CAPTURE);
  });
});
