// @effect-diagnostics nodeBuiltinImport:off -- The Linux helper is its own Node process outside the server's runtime.
// @effect-diagnostics globalTimers:off -- Settle waits and the parent check are plain process timers.
/**
 * goat-computer-use for Linux: the helper GOAT spawns to observe and act on one desktop
 * (WS10 #1138). It speaks the computer use protocol on stdio and runs the pinned Cua Driver as
 * its only child. Packaged by scripts/build-computer-use-helper-linux.ts with the driver in
 * ./cua-driver beside this bundle; GOAT_COMPUTER_USE_DRIVER points elsewhere in development.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { COMPUTER_USE_MAX_FRAME_BYTES } from "@goat/contracts";
import { cuaDriverListingEnvironment, cuaDriverRelease } from "@goat/shared/cuaDriverRelease";

import { gdbusRunner, makeSecureFocusProbe } from "./atspiFocus.ts";
import { startDriver } from "./CuaDriverMcp.ts";
import { serveHelperChannel } from "./helperChannel.ts";
import { makeLinuxHelper } from "./LinuxComputerUseHelper.ts";
import { detectLinuxSession, linuxCapabilities, parseGnomeShellMajor } from "./linuxSession.ts";

/** What the driver may see of this process's environment: the session, nothing else. */
const SESSION_NAMES = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "DISPLAY",
  "XAUTHORITY",
  "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR",
  "XDG_SESSION_TYPE",
  "XDG_CURRENT_DESKTOP",
  "XDG_DATA_DIRS",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "DBUS_SESSION_BUS_ADDRESS",
] as const;

const SETTLE_MS = 300;
const PARENT_CHECK_MS = 2_000;

const environment = process.env;
const session = (() => {
  const facts = {
    display: environment.DISPLAY,
    waylandDisplay: environment.WAYLAND_DISPLAY,
    sessionBus: environment.DBUS_SESSION_BUS_ADDRESS,
    currentDesktop: environment.XDG_CURRENT_DESKTOP,
    gnomeShellMajor: null as number | null,
  };
  if (!facts.display && facts.waylandDisplay && /GNOME/iu.test(facts.currentDesktop ?? "")) {
    try {
      facts.gnomeShellMajor = parseGnomeShellMajor(
        NodeChildProcess.execFileSync("gnome-shell", ["--version"], {
          timeout: 2_000,
          encoding: "utf8",
        }),
      );
    } catch {
      facts.gnomeShellMajor = null;
    }
  }
  return detectLinuxSession(facts);
})();

const driverEnvironment: Record<string, string> = {};
for (const name of SESSION_NAMES) {
  const value = environment[name];
  if (value !== undefined) driverEnvironment[name] = value;
}
Object.assign(driverEnvironment, session.driverEnvironment);
// Given nothing, the listing environment is just the telemetry and update-check opt-outs.
Object.assign(driverEnvironment, cuaDriverListingEnvironment({}));
// oxlint-disable-next-line goat/no-global-process-runtime -- The helper is a plain Node process with no Effect runtime.
const driverVersion = cuaDriverRelease("linux", process.arch)?.version ?? "unknown";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const driverPath =
  environment.GOAT_COMPUTER_USE_DRIVER?.trim() || NodePath.join(here, "cua-driver", "cua-driver");

const helper = makeLinuxHelper({
  session,
  screen: environment.DISPLAY || environment.WAYLAND_DISPLAY || "none",
  startDriver: () =>
    startDriver({
      executable: driverPath,
      environment: driverEnvironment,
      expectedVersion: driverVersion,
    }),
  secureFocus: makeSecureFocusProbe(gdbusRunner(driverEnvironment)),
  uinputWritable: () =>
    NodeFS.promises.access("/dev/uinput", NodeFS.constants.W_OK).then(
      () => true,
      () => false,
    ),
  settle: () => new Promise((resolve) => setTimeout(resolve, SETTLE_MS)),
  newId: () => NodeCrypto.randomUUID(),
});

let ending = false;
const end = (code: number) => {
  if (ending) return;
  ending = true;
  void helper.close().finally(() => process.exit(code));
};
process.once("SIGTERM", () => end(0));
process.once("SIGINT", () => end(0));
process.once("SIGHUP", () => end(0));
// A launcher that died without closing stdin still ends the helper.
const parent = process.ppid;
setInterval(() => {
  if (process.ppid !== parent) end(0);
}, PARENT_CHECK_MS).unref();

void serveHelperChannel({
  input: process.stdin,
  write: (line) => process.stdout.write(line),
  binding: {
    executable:
      environment.GOAT_COMPUTER_USE_EXECUTABLE?.trim() || process.argv[1] || process.execPath,
    pid: process.pid,
    generation: NodeCrypto.randomUUID(),
  },
  capabilities: linuxCapabilities(session),
  maxFrameBytes: COMPUTER_USE_MAX_FRAME_BYTES,
  helper,
}).then(() => end(0));
