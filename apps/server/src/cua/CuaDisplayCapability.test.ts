import { describe, expect, it } from "@effect/vitest";

import {
  classifyDarwin,
  classifyLinux,
  classifyWindows,
  MAC_GRANTS_REASON,
  MAC_STANDALONE_REASON,
  parseMacGrants,
  withMacGrants,
  ldconfigLibraries,
  localDisplayNumber,
  tasklistSession,
  x11SetupOutcome,
  x11SetupRequest,
  x11SocketDisplays,
  xauthorityCookie,
  xServerAuthFile,
  type LinuxDisplayFacts,
} from "./CuaDisplayCapability.ts";

// `ldconfig -p` on Debian 13 with the X client libraries the driver links.
const LDCONFIG_DEBIAN = [
  "1234 libs found in cache `/etc/ld.so.cache'",
  "\tlibxkbcommon.so.0 (libc6,x86-64) => /lib/x86_64-linux-gnu/libxkbcommon.so.0",
  "\tlibXi.so.6 (libc6,x86-64) => /lib/x86_64-linux-gnu/libXi.so.6",
  "\tlibX11.so.6 (libc6,x86-64) => /lib/x86_64-linux-gnu/libX11.so.6",
  "\tlibc.so.6 (libc6,x86-64, OS ABI: Linux 3.2.0) => /lib/x86_64-linux-gnu/libc.so.6",
  "",
].join("\n");

// An Xvfb started by xvfb-run, as /proc/<pid>/cmdline stores it.
const XVFB_CMDLINE = [
  "Xvfb",
  ":1",
  "-screen",
  "0",
  "1920x1200x24",
  "-nolisten",
  "tcp",
  "-auth",
  "/tmp/xvfb-run.Qx81/Xauthority",
  "",
].join("\0");

/** One Xauthority record: family, address, display number, auth name, auth data. */
function xauthRecord(
  family: number,
  address: string,
  number: string,
  name: string,
  data: Uint8Array,
) {
  const encoder = new TextEncoder();
  const fields = [encoder.encode(address), encoder.encode(number), encoder.encode(name), data];
  const bytes: number[] = [family >> 8, family & 0xff];
  for (const field of fields) bytes.push(field.length >> 8, field.length & 0xff, ...field);
  return bytes;
}

const COOKIE = Uint8Array.from({ length: 16 }, (_, index) => index + 1);

const liveWayland = { display: "wayland-0", socket: "/run/user/1000/wayland-0", reachable: true };

const facts = (overrides: Partial<LinuxDisplayFacts> = {}): LinuxDisplayFacts => ({
  user: "root",
  wayland: null,
  displays: [{ display: 1, outcome: "ok", xauthority: "/tmp/xvfb-run.Qx81/Xauthority" }],
  libraries: ldconfigLibraries(LDCONFIG_DEBIAN),
  sessionBus: "unix:path=/run/user/1000/bus",
  runtimeDir: "/run/user/1000",
  atSpi: true,
  busIssues: [],
  ...overrides,
});

describe("Linux display parsing", () => {
  it("lists local X sockets lowest first and ignores other entries", () => {
    expect(x11SocketDisplays(["X6", "X1", ".lock", "X10", "X3", "X7", "Xfoo"])).toEqual([
      1, 3, 6, 7, 10,
    ]);
  });

  it("reads local DISPLAY values and ignores forwarded ones", () => {
    expect(localDisplayNumber(":1")).toBe(1);
    expect(localDisplayNumber(":3.0")).toBe(3);
    expect(localDisplayNumber("unix:6")).toBe(6);
    expect(localDisplayNumber("localhost:10.0")).toBeNull();
    expect(localDisplayNumber(undefined)).toBeNull();
  });

  it("finds the cookie file on the X server command line for that display only", () => {
    expect(xServerAuthFile(XVFB_CMDLINE, 1)).toBe("/tmp/xvfb-run.Qx81/Xauthority");
    expect(xServerAuthFile(XVFB_CMDLINE, 3)).toBeNull();
    expect(
      xServerAuthFile(["/usr/bin/bash", ":1", "-auth", "/tmp/x", ""].join("\0"), 1),
    ).toBeNull();
  });

  it("takes the MIT cookie for the display from an Xauthority file", () => {
    const file = Uint8Array.from([
      ...xauthRecord(256, "cursor-2", "3", "MIT-MAGIC-COOKIE-1", Uint8Array.of(9, 9)),
      ...xauthRecord(256, "cursor-2", "1", "MIT-MAGIC-COOKIE-1", COOKIE),
    ]);
    expect(xauthorityCookie(file, 1)).toEqual(COOKIE);
    expect(xauthorityCookie(file, 6)).toBeNull();
    const wild = Uint8Array.from(xauthRecord(65_535, "", "", "MIT-MAGIC-COOKIE-1", COOKIE));
    expect(xauthorityCookie(wild, 6)).toEqual(COOKIE);
    expect(xauthorityCookie(file.subarray(0, 7), 1)).toBeNull();
  });

  it("builds a little-endian X11 setup request with the cookie padded to four bytes", () => {
    const bare = x11SetupRequest(null);
    expect([...bare]).toEqual([0x6c, 0, 11, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const authed = x11SetupRequest(COOKIE);
    expect(authed.length).toBe(12 + 20 + 16);
    expect([authed[6], authed[8]]).toEqual([18, 16]);
    expect(new TextDecoder().decode(authed.subarray(12, 30))).toBe("MIT-MAGIC-COOKIE-1");
    expect([...authed.subarray(32)]).toEqual([...COOKIE]);
  });

  it("reads the server's setup answer", () => {
    expect(x11SetupOutcome(1)).toBe("ok");
    expect(x11SetupOutcome(0)).toBe("refused");
    expect(x11SetupOutcome(2)).toBe("refused");
    expect(x11SetupOutcome(undefined)).toBe("unreachable");
  });

  it("reads library names from ldconfig", () => {
    expect([...ldconfigLibraries(LDCONFIG_DEBIAN)]).toEqual([
      "libxkbcommon.so.0",
      "libXi.so.6",
      "libX11.so.6",
      "libc.so.6",
    ]);
  });
});

describe("classifyLinux", () => {
  it("is available on an X display with AT-SPI and a session bus, and carries the whole context", () => {
    expect(classifyLinux(facts())).toEqual({
      capability: "available",
      reason: "Uses X display :1.",
      display: ":1",
      environment: [
        { name: "DISPLAY", value: ":1" },
        { name: "XAUTHORITY", value: "/tmp/xvfb-run.Qx81/Xauthority" },
        { name: "DBUS_SESSION_BUS_ADDRESS", value: "unix:path=/run/user/1000/bus" },
        { name: "XDG_RUNTIME_DIR", value: "/run/user/1000" },
      ],
    });
  });

  it("is partial on Xvfb when no session bus answers, as on a headless bot VM", () => {
    const result = classifyLinux(
      facts({
        atSpi: false,
        sessionBus: null,
        runtimeDir: null,
        busIssues: ["the D-Bus session bus at unix:path=/run/user/0/bus does not answer"],
      }),
    );
    expect(result.capability).toBe("partial");
    expect(result.display).toBe(":1");
    expect(result.reason).toBe(
      "Agents can take screenshots and use the mouse and keyboard on :1, but cannot read app controls: the D-Bus session bus at unix:path=/run/user/0/bus does not answer.",
    );
    // An address that did not answer is never handed to the driver.
    expect(result.environment).toEqual([
      { name: "DISPLAY", value: ":1" },
      { name: "XAUTHORITY", value: "/tmp/xvfb-run.Qx81/Xauthority" },
    ]);
  });

  it("is partial when the session bus answers but AT-SPI does not", () => {
    const result = classifyLinux(
      facts({
        atSpi: false,
        busIssues: ["AT-SPI (at-spi2-core) is not available on the session bus"],
      }),
    );
    expect(result.capability).toBe("partial");
    expect(result.reason).toContain("AT-SPI (at-spi2-core) is not available on the session bus");
    expect(result.environment).toContainEqual({
      name: "DBUS_SESSION_BUS_ADDRESS",
      value: "unix:path=/run/user/1000/bus",
    });
  });

  it("is unavailable when a library the driver links is missing", () => {
    const libraries = new Set(["libX11.so.6", "libxkbcommon.so.0"]);
    const result = classifyLinux(facts({ libraries }));
    expect(result.capability).toBe("unavailable");
    expect(result.reason).toContain("libXi.so.6");
    expect(result.reason).toContain("apt install libxi6");
  });

  it("does not guess about libraries it could not list", () => {
    expect(classifyLinux(facts({ libraries: null })).capability).toBe("available");
  });

  it("is unavailable without a reachable display, naming refused displays", () => {
    expect(classifyLinux(facts({ displays: [] }))).toMatchObject({
      capability: "unavailable",
      reason:
        "No X display is reachable for root. Sign in to a desktop session on this computer or start Xvfb.",
      environment: [],
    });
    const refused = classifyLinux(
      facts({
        displays: [
          { display: 1, outcome: "refused", xauthority: null },
          { display: 3, outcome: "refused", xauthority: null },
          { display: 7, outcome: "unreachable", xauthority: null },
        ],
      }),
    );
    expect(refused.capability).toBe("unavailable");
    expect(refused.reason).toBe(
      "root cannot open the X displays here (:1, :3): the X server refused the connection.",
    );
  });

  it("is partial on a live Wayland socket without XWayland, on the driver's Wayland backend", () => {
    const result = classifyLinux(facts({ displays: [], wayland: liveWayland }));
    expect(result.capability).toBe("partial");
    expect(result.display).toBe("wayland-0");
    expect(result.environment).toContainEqual({ name: "WAYLAND_DISPLAY", value: "wayland-0" });
    expect(result.environment).toContainEqual({ name: "CUA_DRIVER_RS_ENABLE_WAYLAND", value: "1" });
  });

  it("is unavailable when the Wayland variables name a session that is gone", () => {
    const result = classifyLinux(
      facts({ displays: [], wayland: { ...liveWayland, reachable: false } }),
    );
    expect(result).toMatchObject({ capability: "unavailable", environment: [] });
    expect(result.reason).toBe(
      "The Wayland session named in this server's environment (wayland-0) is not running, and no X display is reachable for root.",
    );
  });

  it("applies the library check on Wayland too", () => {
    const result = classifyLinux(
      facts({ displays: [], wayland: liveWayland, libraries: new Set(["libxkbcommon.so.0"]) }),
    );
    expect(result.capability).toBe("unavailable");
    expect(result.reason).toContain("libX11.so.6");
  });

  it("uses XWayland when a Wayland session has it, and drops a dead Wayland socket", () => {
    const result = classifyLinux(facts({ wayland: liveWayland }));
    expect(result.capability).toBe("available");
    expect(result.environment).toContainEqual({ name: "DISPLAY", value: ":1" });
    expect(result.environment).toContainEqual({ name: "WAYLAND_DISPLAY", value: "wayland-0" });
    const stale = classifyLinux(facts({ wayland: { ...liveWayland, reachable: false } }));
    expect(stale.environment.map((variable) => variable.name)).not.toContain("WAYLAND_DISPLAY");
  });
});

describe("macOS", () => {
  it("is partial while this user owns the screen, until the driver reports the grants", () => {
    expect(classifyDarwin({ uid: 501, consoleUid: 501, user: "jun" })).toEqual({
      capability: "partial",
      reason: MAC_GRANTS_REASON,
      display: "console",
      environment: [],
    });
    expect(classifyDarwin({ uid: 501, consoleUid: 0, user: "jun" })).toMatchObject({
      capability: "unavailable",
      reason: "No one is signed in at this Mac's screen. Sign in at the Mac, then check again.",
    });
    expect(classifyDarwin({ uid: 501, consoleUid: 502, user: "jun" }).reason).toBe(
      "Another user is signed in at this Mac's screen. Computer use needs jun signed in there.",
    );
    expect(classifyDarwin({ uid: 501, consoleUid: null, user: "jun" }).capability).toBe("partial");
  });

  it("is unavailable under a standalone server, whose grants would land on the launching terminal", () => {
    expect(classifyDarwin({ uid: 501, consoleUid: 501, user: "jun", standalone: true })).toEqual({
      capability: "unavailable",
      reason: MAC_STANDALONE_REASON,
      environment: [],
    });
  });

  it("reads the grants from check_permissions", () => {
    // Shape of the pinned driver's structured result (platform-macos check_permissions.rs).
    expect(
      parseMacGrants(
        JSON.stringify({
          accessibility: true,
          screen_recording: false,
          source: { attribution: "host" },
        }),
      ),
    ).toEqual({ accessibility: true, screenRecording: false });
    expect(parseMacGrants(JSON.stringify({ accessibility: true }))).toBeNull();
    expect(parseMacGrants("not json")).toBeNull();
    expect(parseMacGrants(undefined)).toBeNull();
  });

  it("is available only when the driver reports both grants", () => {
    const atConsole = {
      capability: "partial",
      reason: MAC_GRANTS_REASON,
      display: "console",
    } as const;
    expect(withMacGrants(atConsole, null)).toEqual(atConsole);
    expect(withMacGrants(atConsole, { accessibility: true, screenRecording: true })).toEqual({
      capability: "available",
      reason: "Accessibility and Screen Recording are granted at this Mac.",
      display: "console",
    });
    expect(withMacGrants(atConsole, { accessibility: true, screenRecording: false })).toEqual({
      ...atConsole,
      reason:
        "Screen Recording is not granted at this Mac. Someone at the Mac must allow it in System Settings → Privacy & Security.",
    });
    // A Mac without its user at the screen stays unavailable whatever the grants.
    const away = { capability: "unavailable", reason: "No one is signed in." } as const;
    expect(withMacGrants(away, { accessibility: true, screenRecording: true })).toEqual(away);
  });
});

describe("Windows sessions", () => {
  it("reads the session from tasklist", () => {
    expect(tasklistSession('"node.exe","4120","Services","0","61,204 K"\r\n')).toEqual({
      name: "Services",
      id: 0,
    });
    expect(tasklistSession('\r\n"goat.exe","9876","Console","1","120,000 K"\r\n')).toEqual({
      name: "Console",
      id: 1,
    });
    expect(
      tasklistSession("INFO: No tasks are running which match the specified criteria.\r\n"),
    ).toBeNull();
  });

  it("is unavailable in Session 0, where SSH and services run", () => {
    expect(classifyWindows({ name: "Services", id: 0 }).capability).toBe("unavailable");
    expect(classifyWindows({ name: "Console", id: 1 })).toMatchObject({
      capability: "available",
      display: "session 1",
    });
    expect(classifyWindows(null).capability).toBe("partial");
  });
});
