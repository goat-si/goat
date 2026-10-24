// @effect-diagnostics nodeBuiltinImport:off -- The Linux helper is its own Node process; zlib reads its own capture.
import * as NodeChildProcess from "node:child_process";
import * as NodeZlib from "node:zlib";

import {
  COMPUTER_USE_METHODS,
  COMPUTER_USE_PROTOCOL_VERSION,
  type ComputerUseCapabilities,
  type ComputerUseReadiness,
} from "@goat/contracts";

/**
 * The desktop a Linux helper drives and what it can do there (WS10 #1138). X11 and XWayland
 * windows go through Cua Driver's X11 backend. A Wayland session without XWayland gets AT-SPI
 * only in the background, because Wayland has no way to send input or capture one window
 * without focus; the driver's experimental Wayland backend is turned on for it except on
 * GNOME 50 or later, where pinned 0.37.0 lacks 0.38.0's guard against starting its GNOME Shell
 * helper unsafely.
 */

export type LinuxDisplayServer = "x11" | "xwayland" | "wayland" | "none";

export interface LinuxSessionFacts {
  readonly display: string | undefined;
  readonly waylandDisplay: string | undefined;
  readonly sessionBus: string | undefined;
  readonly currentDesktop: string | undefined;
  /** Major version from `gnome-shell --version`, when GNOME Shell is installed. */
  readonly gnomeShellMajor: number | null;
}

export interface LinuxSession {
  readonly displayServer: LinuxDisplayServer;
  /** Why this helper cannot reach a desktop at all; every window method refuses with it. */
  readonly unavailable?: string;
  /** Why the driver may not drive this Wayland compositor; window methods are unsupported. */
  readonly unsupported?: string;
  readonly pointerAndKeysInBackground: boolean;
  /** Extra driver environment this session needs. */
  readonly driverEnvironment: Readonly<Record<string, string>>;
}

const present = (value: string | undefined) => value !== undefined && value.trim() !== "";

export function detectLinuxSession(facts: LinuxSessionFacts): LinuxSession {
  const x11 = present(facts.display);
  const wayland = present(facts.waylandDisplay);
  const displayServer: LinuxDisplayServer = x11
    ? wayland
      ? "xwayland"
      : "x11"
    : wayland
      ? "wayland"
      : "none";
  const base = { displayServer, pointerAndKeysInBackground: x11, driverEnvironment: {} };
  if (displayServer === "none")
    return {
      ...base,
      unavailable:
        "No desktop session is reachable: neither DISPLAY nor WAYLAND_DISPLAY is set. Sign in to a desktop on this computer or start Xvfb.",
    };
  if (!present(facts.sessionBus))
    return {
      ...base,
      unavailable:
        "No D-Bus session bus is set (DBUS_SESSION_BUS_ADDRESS), and AT-SPI needs one to read app controls.",
    };
  if (displayServer !== "wayland") return base;
  const gnome = (facts.currentDesktop ?? "").toUpperCase().split(":").includes("GNOME");
  if (gnome && facts.gnomeShellMajor !== null && facts.gnomeShellMajor >= 50)
    return {
      ...base,
      unsupported:
        "GNOME " +
        facts.gnomeShellMajor +
        " on Wayland is not supported by Cua Driver 0.37.0, which cannot start its GNOME Shell helper safely there. Sign in to an X11 session, or wait for GOAT to carry Cua Driver 0.38.0.",
    };
  // 0.37.0 ships its Wayland backend off.
  return { ...base, driverEnvironment: { CUA_DRIVER_RS_ENABLE_WAYLAND: "1" } };
}

const parseGnomeShellMajor = (output: string): number | null => {
  const match = /GNOME Shell (\d+)/u.exec(output);
  return match ? Number(match[1]) : null;
};

/** The session environment variables a Linux session's facts come from. */
export interface LinuxSessionEnvironment {
  readonly DISPLAY?: string | undefined;
  readonly WAYLAND_DISPLAY?: string | undefined;
  readonly DBUS_SESSION_BUS_ADDRESS?: string | undefined;
  readonly XDG_CURRENT_DESKTOP?: string | undefined;
}

/**
 * The facts the helper and the server's readiness check both judge a session by, so neither can
 * call a desktop ready that the other refuses. GNOME Shell's version decides only on Wayland GNOME,
 * so only there is it read.
 */
export const linuxSessionFacts = (
  environment: LinuxSessionEnvironment,
  gnomeShellVersion: () => string | null,
): LinuxSessionFacts => {
  const facts = {
    display: environment.DISPLAY,
    waylandDisplay: environment.WAYLAND_DISPLAY,
    sessionBus: environment.DBUS_SESSION_BUS_ADDRESS,
    currentDesktop: environment.XDG_CURRENT_DESKTOP,
  };
  const waylandGnome =
    !facts.display &&
    facts.waylandDisplay !== undefined &&
    /GNOME/iu.test(facts.currentDesktop ?? "");
  const version = waylandGnome ? gnomeShellVersion() : null;
  return { ...facts, gnomeShellMajor: version === null ? null : parseGnomeShellMajor(version) };
};

/** `gnome-shell --version` in the session's environment, or null when it cannot be read. */
export const readGnomeShellVersion = (environment: NodeJS.ProcessEnv): string | null => {
  try {
    return NodeChildProcess.execFileSync("gnome-shell", ["--version"], {
      timeout: 2_000,
      encoding: "utf8",
      env: environment,
    });
  } catch {
    return null;
  }
};

/** Methods this helper does not serve yet: the safety-signal watch (#1235). */
const NOT_YET: ReadonlySet<string> = new Set(["watch", "unwatch"]);

export function linuxCapabilities(session: LinuxSession): ComputerUseCapabilities {
  return {
    protocol: COMPUTER_USE_PROTOCOL_VERSION,
    platform: "linux",
    methods: Object.fromEntries(
      COMPUTER_USE_METHODS.map((method) => [
        method,
        NOT_YET.has(method) ||
        (session.unsupported !== undefined && method !== "capabilities" && method !== "permissions")
          ? "unsupported"
          : "supported",
      ]),
    ) as ComputerUseCapabilities["methods"],
    backgroundDelivery: session.unavailable === undefined && session.unsupported === undefined,
    // No watch yet, so neither signal; the server refuses unattended use until both are here.
    signals: { privateMode: "unsupported", humanInput: "unsupported" },
  };
}

/**
 * Readiness as the contract's separate steps (D10). Linux has no OS grant for AT-SPI or for X11
 * capture, so those read as granted; whether they work is the tree and capture steps, proven by
 * a real read. Wayland screen capture needs the desktop's consent, pending until a capture
 * proves it. The helper answers only after its hello, so it is always authenticated here.
 */
export interface ReadinessFacts {
  readonly session: LinuxSession;
  readonly driver: {
    readonly x11: boolean;
    readonly wayland: boolean;
    readonly atspi: boolean;
  } | null;
  readonly capture: "uniform" | "varied" | "noWindow" | "failed" | "unproven";
  /** A real AT-SPI read of the captured window's app: windows found, none, or no answer. */
  readonly tree: "ready" | "empty" | "unavailable";
  readonly uinputWritable: boolean;
}

export function linuxReadiness(facts: ReadinessFacts): ComputerUseReadiness {
  const { session } = facts;
  const platform =
    session.displayServer === "none"
      ? {}
      : { platform: { linux: { displayServer: session.displayServer } } };
  const blocked = session.unavailable ?? session.unsupported;
  if (blocked !== undefined || facts.driver === null)
    return {
      grants: { accessibility: "unknown", screenCapture: "unknown" },
      helper: "authenticated",
      capture: "unavailable",
      tree: "unavailable",
      input: "unavailable",
      blockers: [],
      reasons: [blocked ?? "Cua Driver did not start."],
      ...platform,
    };
  const reasons: string[] = [];
  const wayland = session.displayServer === "wayland";
  const tree = facts.driver.atspi ? facts.tree : "unavailable";
  if (tree === "unavailable")
    reasons.push(
      "AT-SPI does not answer on the session bus, so app controls cannot be read. Turn on assistive technologies or install at-spi2-core.",
    );
  if (tree === "empty") reasons.push("The app that was checked shows no windows to AT-SPI.");
  const capture =
    facts.capture === "varied"
      ? "ready"
      : facts.capture === "uniform"
        ? "blank"
        : facts.capture === "noWindow"
          ? "noWindow"
          : wayland
            ? "pending"
            : "unavailable";
  if (capture === "blank") reasons.push("A window capture came back as one solid color.");
  if (capture === "noWindow") reasons.push("No window is open to prove capture with.");
  if (capture === "pending")
    reasons.push(
      "Screen capture on Wayland needs the desktop's consent for this helper, or the compositor cannot show one window.",
    );
  if (capture === "unavailable") reasons.push("The driver could not capture a window.");
  const input = wayland ? "foregroundOnly" : facts.uinputWritable ? "background" : "foregroundOnly";
  if (input === "foregroundOnly")
    reasons.push(
      wayland
        ? "Wayland cannot send pointer or key input to a window in the background; controls still work through AT-SPI."
        : "Background pointer and key input needs a writable /dev/uinput and an X server that accepts new input devices; controls still work through AT-SPI.",
    );
  return {
    grants: {
      accessibility: "granted",
      screenCapture: wayland ? (capture === "ready" ? "granted" : "pending") : "granted",
    },
    helper: "authenticated",
    capture,
    tree,
    input,
    // Screen lock and session-switch signals (logind, the screensaver) are not read yet.
    blockers: [],
    reasons,
    ...platform,
  };
}

/**
 * Whether a PNG holds a single color: "uniform", "varied", or undefined for a layout this does
 * not read (only 8-bit truecolor, with or without alpha, not interlaced).
 */
export function pngColors(bytes: Uint8Array): "uniform" | "varied" | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 33 || view.getUint32(0) !== 0x89504e47) return undefined;
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const data: Uint8Array[] = [];
  while (offset + 8 <= bytes.byteLength) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      const header = new DataView(body.buffer, body.byteOffset, body.byteLength);
      width = header.getUint32(0);
      height = header.getUint32(4);
      const depth = body[8];
      const color = body[9];
      if (depth !== 8 || (color !== 2 && color !== 6) || body[12] !== 0) return undefined;
      channels = color === 6 ? 4 : 3;
    } else if (type === "IDAT") data.push(body);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  if (width === 0 || height === 0 || channels === 0) return undefined;
  let raw: Uint8Array;
  try {
    raw = NodeZlib.inflateSync(Buffer.concat(data));
  } catch {
    return undefined;
  }
  const stride = width * channels;
  if (raw.byteLength < (stride + 1) * height) return undefined;
  let previous = new Uint8Array(stride);
  let first: Uint8Array | undefined;
  for (let row = 0; row < height; row++) {
    const filter = raw[row * (stride + 1)];
    const line = raw.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1));
    const out = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? (out[i - channels] ?? 0) : 0;
      const up = previous[i] ?? 0;
      const corner = i >= channels ? (previous[i - channels] ?? 0) : 0;
      const value = line[i] ?? 0;
      const predicted =
        filter === 1
          ? left
          : filter === 2
            ? up
            : filter === 3
              ? (left + up) >> 1
              : filter === 4
                ? paeth(left, up, corner)
                : 0;
      out[i] = (value + predicted) & 0xff;
    }
    first ??= out.slice(0, channels);
    for (let i = 0; i < stride; i++) if (out[i] !== first[i % channels]) return "varied";
    previous = out;
  }
  return "uniform";
}

function paeth(a: number, b: number, c: number) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}
