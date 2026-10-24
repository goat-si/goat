// @effect-diagnostics nodeBuiltinImport:off -- Effect has no Unix-socket client; the X11 handshake needs one.
import * as NodeNet from "node:net";

import type { CuaDisplayCapability } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { A11Y_GET_ADDRESS, dbusProbe } from "./CuaDbusProbe.ts";

export interface CuaDisplayVariable {
  readonly name: string;
  readonly value: string;
}

/**
 * A capability verdict plus the environment the driver needs to reach that screen. A server
 * started over SSH has none of the desktop session's variables, so the probe finds them.
 */
export interface CuaDisplayProbe extends CuaDisplayCapability {
  readonly environment: ReadonlyArray<CuaDisplayVariable>;
}

/** Local display numbers from `/tmp/.X11-unix` entries such as `X1`, lowest first. */
export function x11SocketDisplays(names: ReadonlyArray<string>): ReadonlyArray<number> {
  return names
    .flatMap((name) => {
      const match = /^X(\d{1,4})$/u.exec(name);
      return match ? [Number(match[1])] : [];
    })
    .toSorted((a, b) => a - b);
}

/** The display number of a local DISPLAY value; null for TCP or forwarded displays. */
export function localDisplayNumber(display: string | undefined): number | null {
  const match = /^(?:unix)?:(\d{1,4})(?:\.\d+)?$/u.exec(display?.trim() ?? "");
  return match ? Number(match[1]) : null;
}

const X_SERVERS = new Set(["X", "Xorg", "Xvfb", "Xwayland", "Xvnc", "Xtigervnc", "Xephyr"]);

/** The `-auth` file of the X server serving `display`, from one `/proc/<pid>/cmdline`. */
export function xServerAuthFile(cmdline: string, display: number): string | null {
  const args = cmdline.split("\0").filter((arg) => arg !== "");
  const program = args[0]?.split("/").at(-1);
  if (program === undefined || !X_SERVERS.has(program) || !args.includes(`:${display}`))
    return null;
  const index = args.indexOf("-auth");
  return index > 0 ? (args[index + 1] ?? null) : null;
}

const FAMILY_LOCAL = 256;
const FAMILY_WILD = 65_535;
const MIT_MAGIC_COOKIE = "MIT-MAGIC-COOKIE-1";

/** The MIT-MAGIC-COOKIE-1 for a local display from an Xauthority file, if it has one. */
export function xauthorityCookie(bytes: Uint8Array, display: number): Uint8Array | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  let offset = 0;
  const field = () => {
    if (offset + 2 > bytes.byteLength) return null;
    const length = view.getUint16(offset);
    offset += 2;
    if (offset + length > bytes.byteLength) return null;
    const value = bytes.subarray(offset, offset + length);
    offset += length;
    return value;
  };
  while (offset + 2 <= bytes.byteLength) {
    const family = view.getUint16(offset);
    offset += 2;
    const address = field();
    const number = field();
    const name = field();
    const data = field();
    if (!address || !number || !name || !data) return null;
    const numberText = decoder.decode(number);
    if (
      (family === FAMILY_LOCAL || family === FAMILY_WILD) &&
      (numberText === "" || numberText === String(display)) &&
      decoder.decode(name) === MIT_MAGIC_COOKIE
    )
      return data;
  }
  return null;
}

const pad4 = (length: number) => (4 - (length % 4)) % 4;

/** An X11 connection setup request, optionally carrying a MIT-MAGIC-COOKIE-1. */
export function x11SetupRequest(cookie: Uint8Array | null): Uint8Array {
  const name = cookie ? new TextEncoder().encode(MIT_MAGIC_COOKIE) : new Uint8Array();
  const data = cookie ?? new Uint8Array();
  const request = new Uint8Array(
    12 + name.length + pad4(name.length) + data.length + pad4(data.length),
  );
  const view = new DataView(request.buffer);
  request[0] = 0x6c; // "l": little-endian
  view.setUint16(2, 11, true);
  view.setUint16(4, 0, true);
  view.setUint16(6, name.length, true);
  view.setUint16(8, data.length, true);
  request.set(name, 12);
  request.set(data, 12 + name.length + pad4(name.length));
  return request;
}

export type X11Outcome = "ok" | "refused" | "unreachable";

/** The first byte of the server's setup reply: 1 is success; 0 (failed) and 2 (authenticate) refuse. */
export function x11SetupOutcome(firstByte: number | undefined): X11Outcome {
  if (firstByte === 1) return "ok";
  return firstByte === 0 || firstByte === 2 ? "refused" : "unreachable";
}

/** Shared-library names from `ldconfig -p`. */
export function ldconfigLibraries(output: string): ReadonlySet<string> {
  const names = new Set<string>();
  for (const line of output.split(/\r?\n/u)) {
    const match = /^\s+(\S+)\s+\(/u.exec(line);
    if (match?.[1]) names.add(match[1]);
  }
  return names;
}

/** What the pinned Linux driver binary links against, with the Debian/Ubuntu package for each. */
const LINUX_DRIVER_LIBRARIES = [
  { soname: "libX11.so.6", package: "libx11-6" },
  { soname: "libXi.so.6", package: "libxi6" },
  { soname: "libxkbcommon.so.0", package: "libxkbcommon0" },
] as const;

export interface LinuxDisplayFacts {
  readonly user: string;
  /**
   * The DISPLAY this server was started with. When it names one, that display is the only one
   * computer use may use: a session reachable some other way, such as an inherited Wayland
   * socket, may be another desktop (#1358).
   */
  readonly requestedDisplay?: string;
  /** The session's Wayland socket, when the environment names one, and whether it accepts. */
  readonly wayland: {
    readonly display: string;
    readonly socket: string;
    readonly reachable: boolean;
  } | null;
  /** Displays tried, in order, with what each answered. */
  readonly displays: ReadonlyArray<{
    readonly display: number;
    readonly outcome: X11Outcome;
    readonly xauthority: string | null;
  }>;
  /** Null when the library list could not be read; the driver then reports its own failure. */
  readonly libraries: ReadonlySet<string> | null;
  /** A session bus that answered Hello; addresses that did not answer are never passed on. */
  readonly sessionBus: string | null;
  readonly runtimeDir: string | null;
  /** Whether org.a11y.Bus handed out an AT-SPI bus address that answered too. */
  readonly atSpi: boolean;
  /** Why the session bus or AT-SPI is missing, for the reason. */
  readonly busIssues: ReadonlyArray<string>;
}

function missingLibraries(facts: LinuxDisplayFacts) {
  return facts.libraries
    ? LINUX_DRIVER_LIBRARIES.filter((library) => !facts.libraries?.has(library.soname))
    : [];
}

const missingLibrariesReason = (missing: ReturnType<typeof missingLibraries>) =>
  `Computer use needs ${missing.map((library) => library.soname).join(", ")} on this computer (Debian/Ubuntu: apt install ${missing.map((library) => library.package).join(" ")}).`;

export function classifyLinux(facts: LinuxDisplayFacts): CuaDisplayProbe {
  const reachable = facts.displays.find((entry) => entry.outcome === "ok");
  const session: CuaDisplayVariable[] = [
    ...(facts.sessionBus ? [{ name: "DBUS_SESSION_BUS_ADDRESS", value: facts.sessionBus }] : []),
    ...(facts.runtimeDir ? [{ name: "XDG_RUNTIME_DIR", value: facts.runtimeDir }] : []),
  ];
  const wayland = facts.wayland?.reachable ? facts.wayland : null;
  // The binary links the X client libraries even on Wayland, so it cannot start without them.
  const missing = missingLibraries(facts);
  if (!reachable && facts.requestedDisplay) {
    const requested = facts.requestedDisplay;
    const refused = facts.displays.some((entry) => entry.outcome === "refused");
    return {
      capability: "unavailable",
      reason:
        localDisplayNumber(requested) === null
          ? `This server was started with DISPLAY=${requested}, a forwarded or remote X display, which computer use cannot use. Start GOAT with a local display, or without DISPLAY to use the desktop signed in on this computer.`
          : `This server was started with DISPLAY=${requested}, and that X display ${refused ? `refused ${facts.user}'s connection` : "is not answering"}. Start that display, or start GOAT without DISPLAY to use the desktop signed in on this computer.`,
      environment: [],
    };
  }
  if (!reachable) {
    if (wayland) {
      const environment = [
        { name: "WAYLAND_DISPLAY", value: wayland.display },
        { name: "XDG_SESSION_TYPE", value: "wayland" },
        // 0.37.0 has no other backend for a session without XWayland, and ships this one off.
        { name: "CUA_DRIVER_RS_ENABLE_WAYLAND", value: "1" },
        ...session,
      ];
      if (missing.length > 0)
        return {
          capability: "unavailable",
          reason: missingLibrariesReason(missing),
          display: wayland.display,
          environment,
        };
      return {
        capability: "partial",
        reason:
          "This Wayland session has no X display (XWayland), so computer use runs on Cua Driver's experimental Wayland support: it reaches fewer apps, and your desktop may ask to approve screen capture.",
        display: wayland.display,
        environment,
      };
    }
    const refused = facts.displays.filter((entry) => entry.outcome === "refused");
    return {
      capability: "unavailable",
      reason:
        refused.length > 0
          ? `${facts.user} cannot open the X display${refused.length > 1 ? "s" : ""} here (${refused.map((entry) => `:${entry.display}`).join(", ")}): the X server refused the connection.`
          : facts.wayland
            ? `The Wayland session named in this server's environment (${facts.wayland.display}) is not running, and no X display is reachable for ${facts.user}.`
            : `No X display is reachable for ${facts.user}. Sign in to a desktop session on this computer or start Xvfb.`,
      environment: [],
    };
  }
  const display = `:${reachable.display}`;
  const environment = [
    { name: "DISPLAY", value: display },
    ...(reachable.xauthority ? [{ name: "XAUTHORITY", value: reachable.xauthority }] : []),
    ...(wayland ? [{ name: "WAYLAND_DISPLAY", value: wayland.display }] : []),
    ...session,
  ];
  if (missing.length > 0) {
    return {
      capability: "unavailable",
      reason: missingLibrariesReason(missing),
      display,
      environment,
    };
  }
  if (!facts.atSpi) {
    return {
      capability: "partial",
      reason: `Agents can take screenshots and use the mouse and keyboard on ${display}, but cannot read app controls: ${facts.busIssues.join(" and ") || "AT-SPI did not answer"}.`,
      display,
      environment,
    };
  }
  return { capability: "available", reason: `Uses X display ${display}.`, display, environment };
}

export const MAC_GRANTS_REASON = "Accessibility and Screen Recording must be granted at this Mac.";

/**
 * macOS grants Accessibility and Screen Recording to the app at the top of the driver's launch
 * chain. Under a standalone server that is whatever terminal or launchd job started GOAT, so the
 * grants would land on the wrong app; the desktop app runs the driver under its own helper.
 */
export const MAC_STANDALONE_REASON =
  "On a Mac, computer use runs through the GOAT desktop app. Open GOAT on this Mac to use it.";

/**
 * The driver needs this user's GUI session, which exists only while they own the console. The
 * grants can only be read by the driver itself, so owning the console is partial until
 * `withMacGrants` sees the running driver report both.
 */
export function classifyDarwin(input: {
  readonly uid: number | undefined;
  readonly consoleUid: number | null;
  readonly user: string;
  /** A server without the desktop app, such as `goat serve` started from a terminal. */
  readonly standalone?: boolean;
}): CuaDisplayProbe {
  if (input.standalone)
    return { capability: "unavailable", reason: MAC_STANDALONE_REASON, environment: [] };
  if (input.consoleUid === null || input.uid === undefined)
    return {
      capability: "partial",
      reason: `Could not tell who is signed in at this Mac. ${MAC_GRANTS_REASON}`,
      environment: [],
    };
  if (input.consoleUid === input.uid)
    return {
      capability: "partial",
      reason: MAC_GRANTS_REASON,
      display: "console",
      environment: [],
    };
  return {
    capability: "unavailable",
    reason:
      input.consoleUid === 0
        ? "No one is signed in at this Mac's screen. Sign in at the Mac, then check again."
        : `Another user is signed in at this Mac's screen. Computer use needs ${input.user} signed in there.`,
    environment: [],
  };
}

export interface MacGrants {
  readonly accessibility: boolean;
  readonly screenRecording: boolean;
}

/** The grants in a `check_permissions` result; null when it does not say. */
export function parseMacGrants(structuredJson: string | undefined): MacGrants | null {
  if (!structuredJson) return null;
  try {
    const value: unknown = JSON.parse(structuredJson);
    if (typeof value !== "object" || value === null) return null;
    const { accessibility, screen_recording: screenRecording } = value as Record<string, unknown>;
    return typeof accessibility === "boolean" && typeof screenRecording === "boolean"
      ? { accessibility, screenRecording }
      : null;
  } catch {
    return null;
  }
}

/** A Mac whose console this user owns is available only once the driver reports both grants. */
export function withMacGrants<T extends CuaDisplayCapability>(
  probe: T,
  grants: MacGrants | null,
): T {
  if (probe.display !== "console" || probe.capability !== "partial" || grants === null)
    return probe;
  const missing = [
    ...(grants.accessibility ? [] : ["Accessibility"]),
    ...(grants.screenRecording ? [] : ["Screen Recording"]),
  ];
  return missing.length === 0
    ? {
        ...probe,
        capability: "available",
        reason: "Accessibility and Screen Recording are granted at this Mac.",
      }
    : {
        ...probe,
        reason: `${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} not granted at this Mac. Someone at the Mac must allow ${missing.length > 1 ? "them" : "it"} in System Settings → Privacy & Security.`,
      };
}

/** Session name and id from `tasklist /FI "PID eq <pid>" /FO CSV /NH`. */
export function tasklistSession(
  output: string,
): { readonly name: string; readonly id: number } | null {
  const line = output.split(/\r?\n/u).find((candidate) => candidate.startsWith('"'));
  if (!line) return null;
  const columns = [...line.matchAll(/"([^"]*)"/gu)].map((match) => match[1] ?? "");
  const id = Number(columns[3]);
  return columns.length >= 4 && Number.isInteger(id) ? { name: columns[2] ?? "", id } : null;
}

/** OpenSSH and services run in Session 0, which has no desktop for the driver to use. */
export function classifyWindows(
  session: { readonly name: string; readonly id: number } | null,
): CuaDisplayProbe {
  if (session === null)
    return {
      capability: "partial",
      reason: "Could not confirm that GOAT runs in a signed-in desktop session on this computer.",
      environment: [],
    };
  if (session.id === 0)
    return {
      capability: "unavailable",
      reason:
        "GOAT runs in Windows Session 0 (a service or SSH session), which has no desktop. Start GOAT from the signed-in desktop on this computer to use computer use.",
      environment: [],
    };
  return {
    capability: "available",
    reason: `Uses desktop session ${session.id}.`,
    display: `session ${session.id}`,
    environment: [],
  };
}

const MAX_DISPLAYS = 8;
const MAX_PROC_ENTRIES = 4_096;

const x11Handshake = (socketPath: string, cookie: Uint8Array | null) =>
  Effect.callback<X11Outcome>((resume) => {
    let settled = false;
    const finish = (outcome: X11Outcome) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resume(Effect.succeed(outcome));
    };
    const socket = NodeNet.createConnection(socketPath);
    socket.once("connect", () => socket.write(x11SetupRequest(cookie)));
    socket.once("data", (chunk: Buffer) => finish(x11SetupOutcome(chunk[0])));
    socket.once("error", () => finish("unreachable"));
    socket.once("close", () => finish("unreachable"));
    return Effect.sync(() => socket.destroy());
  }).pipe(
    Effect.timeoutOrElse({
      duration: "2 seconds",
      orElse: () => Effect.succeed("unreachable" as const),
    }),
  );

/**
 * Tries each Xauthority cookie for the display, then none, and keeps the first the X server
 * accepts. A stale XAUTHORITY must not hide a valid `-auth` file from a restarted Xvfb.
 */
export const chooseX11Auth = Effect.fnUntraced(function* (
  socketPath: string,
  candidates: ReadonlyArray<{ readonly file: string; readonly cookie: Uint8Array }>,
) {
  let outcome: X11Outcome = "unreachable";
  for (const candidate of candidates) {
    outcome = yield* x11Handshake(socketPath, candidate.cookie);
    if (outcome === "ok") return { outcome, xauthority: candidate.file };
    if (outcome === "unreachable") return { outcome, xauthority: null };
  }
  const bare = yield* x11Handshake(socketPath, null);
  return {
    outcome: bare === "unreachable" && outcome === "refused" ? outcome : bare,
    xauthority: null,
  };
});

/** Whether something accepts connections on a Unix socket, such as a Wayland compositor. */
export const unixSocketAccepts = (socketPath: string) =>
  Effect.callback<boolean>((resume) => {
    const socket = NodeNet.createConnection(socketPath);
    const finish = (accepted: boolean) => {
      socket.destroy();
      resume(Effect.succeed(accepted));
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    return Effect.sync(() => socket.destroy());
  }).pipe(Effect.timeoutOrElse({ duration: "2 seconds", orElse: () => Effect.succeed(false) }));

/** Finds a session bus that answers, then asks it for the AT-SPI bus and checks that one too. */
export const probeAccessibilityBuses = Effect.fnUntraced(function* (
  candidates: ReadonlyArray<string>,
  uid: number,
) {
  const issues: string[] = [];
  for (const address of candidates) {
    const result = yield* dbusProbe(address, uid, A11Y_GET_ADDRESS);
    if (!result.answered) {
      issues.push(`the D-Bus session bus at ${address} does not answer`);
      continue;
    }
    if (!result.reply.ok || !result.reply.text) {
      return {
        sessionBus: address,
        atSpi: false,
        issues: ["AT-SPI (at-spi2-core) is not available on the session bus"],
      };
    }
    const atSpi = yield* dbusProbe(result.reply.text, uid);
    return {
      sessionBus: address,
      atSpi: atSpi.answered,
      issues: atSpi.answered ? [] : [`the AT-SPI bus at ${result.reply.text} does not answer`],
    };
  }
  return {
    sessionBus: null,
    atSpi: false,
    issues: issues.length > 0 ? issues : ["no D-Bus session bus is running for this user"],
  };
});

/**
 * The X displays to try. A server given a DISPLAY uses that display or none: trying the others
 * would hand computer use whichever desktop answers, such as the person signed in at the seat
 * when the server was meant for its own Xvfb (#1358). Only a server with no DISPLAY at all, such
 * as one started over SSH, looks for the local desktop.
 */
export function linuxDisplayCandidates(
  display: string | undefined,
  sockets: ReadonlyArray<number>,
): ReadonlyArray<number> {
  if (display?.trim()) {
    const named = localDisplayNumber(display);
    return named === null ? [] : [named];
  }
  return sockets.slice(0, MAX_DISPLAYS);
}

/** The session buses to try, on the same rule: a named bus or none, else this user's own. */
export function linuxBusCandidates(
  address: string | undefined,
  userRuntime: string | null,
): ReadonlyArray<string> {
  if (address?.trim()) return [address.trim()];
  return userRuntime ? [`unix:path=${userRuntime}/bus`] : [];
}

const probeLinux = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const environment = yield* HostProcess.Environment;
  const home = yield* HostProcess.HomeDirectory;
  const uid = yield* HostProcess.UserId;
  const user = (yield* HostProcess.Username) ?? "this user";
  const exists = (file: string) => fs.exists(file).pipe(Effect.orElseSucceed(() => false));

  const preferred = localDisplayNumber(environment.DISPLAY);
  const sockets = x11SocketDisplays(
    yield* fs.readDirectory("/tmp/.X11-unix").pipe(Effect.orElseSucceed(() => [])),
  );
  const candidates = linuxDisplayCandidates(environment.DISPLAY, sockets);

  // Xvfb and display managers keep the cookie in a file named only on their command line.
  const serverAuth = new Map<number, string>();
  if (candidates.length > 0) {
    const pids = (yield* fs.readDirectory("/proc").pipe(Effect.orElseSucceed(() => [])))
      .filter((entry) => /^\d+$/u.test(entry))
      .slice(0, MAX_PROC_ENTRIES);
    for (const pid of pids) {
      const cmdline = yield* fs
        .readFileString(`/proc/${pid}/cmdline`)
        .pipe(Effect.orElseSucceed(() => ""));
      for (const display of candidates) {
        const file = xServerAuthFile(cmdline, display);
        if (file && !serverAuth.has(display)) serverAuth.set(display, file);
      }
    }
  }

  const displays: Array<LinuxDisplayFacts["displays"][number]> = [];
  for (const display of candidates) {
    const files = [
      ...new Set(
        [
          environment.XAUTHORITY?.trim(),
          serverAuth.get(display),
          path.join(home, ".Xauthority"),
        ].filter((file): file is string => typeof file === "string" && file !== ""),
      ),
    ];
    const cookies: Array<{ file: string; cookie: Uint8Array }> = [];
    for (const file of files) {
      const bytes = yield* fs.readFile(file).pipe(Effect.orElseSucceed(() => null));
      const cookie = bytes ? xauthorityCookie(bytes, display) : null;
      if (cookie) cookies.push({ file, cookie });
    }
    const chosen = yield* chooseX11Auth(`/tmp/.X11-unix/X${display}`, cookies);
    displays.push({ display, ...chosen });
    if (chosen.outcome === "ok") break;
  }

  const userRuntime = uid === undefined ? null : `/run/user/${uid}`;
  const runtimeDir =
    environment.XDG_RUNTIME_DIR?.trim() ||
    (userRuntime && (yield* exists(userRuntime)) ? userRuntime : null);
  const busCandidates = linuxBusCandidates(environment.DBUS_SESSION_BUS_ADDRESS, userRuntime);
  const buses =
    uid === undefined
      ? { sessionBus: null, atSpi: false, issues: ["this user's id is unknown"] }
      : yield* probeAccessibilityBuses(busCandidates, uid);

  const ldconfig = (command: string) =>
    spawner.string(ChildProcess.make(command, ["-p"], { stdin: "ignore", stderr: "ignore" }));
  const libraries = yield* ldconfig("ldconfig").pipe(
    Effect.catch(() => ldconfig("/sbin/ldconfig")),
    Effect.map(ldconfigLibraries),
    Effect.map((names) => (names.size > 0 ? names : null)),
    Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.succeed(null) }),
    Effect.orElseSucceed(() => null),
  );

  // A variable left from a session that ended names a socket nobody listens on.
  const waylandName =
    environment.WAYLAND_DISPLAY?.trim() ||
    (environment.XDG_SESSION_TYPE?.toLowerCase() === "wayland" ? "wayland-0" : "");
  const waylandSocket = waylandName.startsWith("/")
    ? waylandName
    : runtimeDir && waylandName
      ? path.join(runtimeDir, waylandName)
      : null;
  const wayland =
    waylandName && waylandSocket
      ? {
          display: waylandName,
          socket: waylandSocket,
          reachable: yield* unixSocketAccepts(waylandSocket),
        }
      : waylandName
        ? { display: waylandName, socket: waylandName, reachable: false }
        : null;

  return classifyLinux({
    user,
    ...(environment.DISPLAY?.trim() ? { requestedDisplay: environment.DISPLAY.trim() } : {}),
    wayland,
    displays,
    libraries,
    sessionBus: buses.sessionBus,
    runtimeDir,
    atSpi: buses.atSpi,
    busIssues: buses.issues,
  });
});

const probeDarwin = Effect.fnUntraced(function* (standalone: boolean) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat("/dev/console").pipe(Effect.orElseSucceed(() => null));
  return classifyDarwin({
    uid: yield* HostProcess.UserId,
    consoleUid: info?.uid._tag === "Some" ? info.uid.value : null,
    user: (yield* HostProcess.Username) ?? "this user",
    standalone,
  });
});

const probeWindows = Effect.fnUntraced(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const output = yield* spawner
    .string(
      ChildProcess.make("tasklist", ["/FI", `PID eq ${process.pid}`, "/FO", "CSV", "/NH"], {
        stdin: "ignore",
        stderr: "ignore",
      }),
    )
    .pipe(
      Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.succeed("") }),
      Effect.orElseSucceed(() => ""),
    );
  return classifyWindows(tasklistSession(output));
});

/**
 * Checks this host's screen now. Results go stale, so callers probe again before each start.
 * `server` says whether the desktop app hosts this server; only it can run the Mac driver.
 */
export const probeDisplay = Effect.fn("CuaDisplayCapability.probe")(function* (
  server: "desktop" | "standalone",
) {
  const platform = yield* HostProcess.Platform;
  if (platform === "linux") return yield* probeLinux();
  if (platform === "darwin") return yield* probeDarwin(server === "standalone");
  if (platform === "win32") return yield* probeWindows();
  return {
    capability: "unavailable",
    reason: "Computer use runs on macOS, Windows, and Linux.",
    environment: [],
  } satisfies CuaDisplayProbe;
});
