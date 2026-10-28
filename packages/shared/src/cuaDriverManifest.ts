// GOAT's capability manifest for the Cua Driver daemon: a launch-time ceiling the driver
// enforces on every tool call, including calls nested inside run_steps and run_script. It
// narrows what any agent can reach through the shared daemon; it cannot judge intent (typing a
// secret into an allowed window stays possible), which is what the unattended lease is for.
// Shapes follow the v3 schema of the pinned driver (cua-driver-core/src/session_manifest.rs at
// cua-driver-rs-v0.37.0), which rejects unknown keys, unknown tools and an empty allow list.

import { BoundedLines } from "./boundedLines.ts";

// @effect-diagnostics-next-line nodeBuiltinImport:off -- Electron main and the standalone server both call this outside an Effect runtime.
import * as NodeChildProcess from "node:child_process";

import {
  CUA_DRIVER_PROBED_SESSION_NAMES,
  DESKTOP_CHANNEL_APP_IDS,
  computerUseHelperBundleId,
  cuaDriverListingEnvironment,
} from "./cuaDriverRelease.ts";

/** Observation, input, batching and session tools agents need for ordinary desktop work. */
export const CUA_DRIVER_ALLOWED_TOOLS = [
  "check_permissions",
  "health_report",
  "get_guide",
  "list_apps",
  "list_windows",
  "get_accessibility_tree",
  "get_window_state",
  "get_screen_size",
  "get_cursor_position",
  "verify_state",
  "zoom",
  "click",
  "double_click",
  "right_click",
  "drag",
  "scroll",
  "move_cursor",
  "type_text",
  "press_key",
  "hotkey",
  "set_value",
  "invoke_menu",
  "bring_to_front",
  "launch_app",
  "kill_app",
  "set_window_frame",
  "run_steps",
  "run_script",
  "start_session",
  "end_session",
  "get_session",
  "list_sessions",
  "get_agent_cursor_state",
  "get_config",
  "set_agent_cursor_enabled",
  "set_agent_cursor_motion",
  "set_agent_cursor_theme",
] as const;

/**
 * Every other tool the pinned driver offers, with why agents never get it. Undeclared tools are
 * refused by the driver too; this list is the reviewed record, and a test keeps it disjoint
 * from the allow list.
 */
export const CUA_DRIVER_EXCLUDED_TOOLS = {
  get_desktop_state:
    "screenshots the whole display, with every other app and GOAT's own windows on it (#1321); get_window_state captures one window",
  install_extension: "installs software on the host",
  install_ffmpeg: "installs software on the host",
  set_config: "driver configuration belongs to GOAT",
  check_for_update: "GOAT pins the driver; updates ship only with GOAT",
  replay_trajectory: "re-runs recorded actions read from disk",
  parse_visual_regions: "needs the optional perception extension GOAT does not ship",
  page: "deprecated browser compatibility tool",
  escalate_session: "deprecated capture-scope escalation",
  get_session_state: "deprecated capture-scope read",
  start_recording: "writes recordings to disk; the manifest grants no file paths",
  stop_recording: "writes recordings to disk; the manifest grants no file paths",
  get_recording_state: "recording is not offered",
  clipboard_read:
    "returns whatever the person last copied, such as passwords, from outside the admitted apps",
  clipboard_write: "replaces the person's clipboard and can load local files into it",
  browser_prepare:
    "browser tools need per-origin grants a launch-time manifest cannot know, and logged-in profiles are never granted; agents drive browsers as ordinary apps or use GOAT's browser",
  browser_navigate: "browser tools need per-origin grants",
  browser_click: "browser tools need per-origin grants",
  browser_type: "browser tools need per-origin grants",
  browser_pointer: "browser tools need per-origin grants",
  browser_select: "browser tools need per-origin grants",
  browser_dialog: "browser tools need per-origin grants",
  browser_download: "saves files to disk; the manifest grants no file paths",
  browser_set_input_files: "uploads local files; the manifest grants no file paths",
  get_browser_state: "browser tools need per-origin grants",
} as const satisfies Readonly<Record<string, string>>;

/**
 * Apps the driver never touches whatever the request: GOAT itself, where a person approves
 * computer use, in every released channel (a dev checkout's own app id stays controllable for
 * testing it), the driver's own app, and credential stores. Matched against the bundle id
 * (case-insensitive) and the app name.
 */
const EXCLUDED_BUNDLE_IDS = new Set([
  "com.trycua.driver",
  // Every released GOAT channel and its helper: any of them can show this host's approval cards.
  ...Object.values(DESKTOP_CHANNEL_APP_IDS).flatMap((id) => [id, computerUseHelperBundleId(id)]),
  "com.apple.keychainaccess",
  "com.apple.passwords",
  "com.1password.1password",
  "com.agilebits.onepassword7",
  "com.1password.safari",
  "com.bitwarden.desktop",
  "org.keepassxc.keepassxc",
  "com.lastpass.lastpass",
  "com.dashlane.dashlanephonefinal",
  "com.nordsec.nordpass",
  "me.proton.pass.electron",
  "me.proton.pass.catalyst",
]);
// Names cover Windows and Linux, where an app is listed by its executable path or desktop name.
// Any non-alphanumeric character bounds a word: snap desktop ids and Windows AUMIDs use "_".
const EXCLUDED_NAME =
  /(?<![\p{L}\p{N}])(1password|bitwarden|keepass(xc)?|lastpass|dashlane|nordpass|proton[ ._-]?pass|keychain access|passwords)(?![\p{L}\p{N}])/iu;
/** The driver, and GOAT's helper on Windows, named by their executables. */
const EXCLUDED_EXECUTABLE = /(^|[\\/])((cua-driver|GOAT Computer Use)\.exe|cua-driver)$/iu;

export interface CuaDriverListedApp {
  readonly bundle_id?: string | null;
  readonly name?: string | null;
  /**
   * A running app's executable path, added by the Windows helper or read from /proc on Linux
   * (the driver gives none).
   */
  readonly executable?: string | null;
  /** The app bundle's path on macOS, as the driver's list_apps reports it. */
  readonly launch_path?: string | null;
  /**
   * The binary inside a macOS app bundle, which is what the driver attests for kill_app (ps
   * comm). Added by GOAT from the bundle's Info.plist; the driver gives none.
   */
  readonly bundle_executable?: string | null;
  readonly pid?: number | null;
  readonly windows?: ReadonlyArray<unknown> | null;
}

/**
 * A Linux app with no desktop entry, granted by the executable the driver attests for a window
 * (/proc/<pid>/exe, session_manifest.rs resource_matches_application). `names` are the list_apps
 * names approvals use for it; the manifest keeps them in a comment so a refresh can find them.
 */
export interface CuaDriverExecutableApp {
  readonly executable: string;
  readonly names: ReadonlyArray<string>;
}

export type CuaDriverAdmittedApp = string | CuaDriverExecutableApp;

/**
 * Bundle ids GOAT admits for general desktop control: every app the driver itself lists (its
 * list_apps result is what it attests a window's app identity against), minus the host GOAT runs
 * in and the exclusions above. On Windows a running program with no Start menu entry has no
 * bundle id; its executable path stands in, which the driver matches against the executable it
 * attests for the window (#1368). On Linux an app with no desktop entry gets an executable grant
 * instead (#1513): the driver only compares Windows paths given as bundle ids. Apps with neither
 * stay out. A macOS app also gets an executable grant for its bundle's binary: the driver judges
 * kill_app only against executable grants (session_manifest.rs process_control), never bundle
 * ids. Desktop hosts refresh this list when an approval names a missing app; standalone servers
 * still list only at host start.
 */
export function admittedCuaApplications(
  apps: ReadonlyArray<CuaDriverListedApp>,
  hostBundleIds: ReadonlyArray<string>,
): ReadonlyArray<CuaDriverAdmittedApp> {
  const host = new Set(hostBundleIds.map(cuaAppKey));
  const admitted = new Set<string>();
  const executables = new Map<string, Set<string>>();
  for (const app of apps) {
    const bundle = app.bundle_id?.trim() ?? "";
    const id = bundle || (app.executable?.trim() ?? "");
    if (!id) continue;
    if (excludedCuaApplication(app, id, host)) continue;
    const binary = bundle ? app.bundle_executable?.trim() : undefined;
    if (binary?.startsWith("/") === true && !executables.has(binary))
      executables.set(binary, new Set());
    if (!bundle && id.startsWith("/")) {
      const names = executables.get(id) ?? new Set<string>();
      const name = app.name?.trim();
      if (name) names.add(name);
      executables.set(id, names);
    } else admitted.add(id);
  }
  const entries: Array<CuaDriverAdmittedApp> = [...admitted];
  for (const [executable, names] of executables)
    entries.push({ executable, names: [...names].sort() });
  const key = (entry: CuaDriverAdmittedApp) =>
    typeof entry === "string" ? entry : entry.executable;
  return entries.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

function excludedCuaApplication(
  app: CuaDriverListedApp,
  id: string,
  host: ReadonlySet<string>,
): boolean {
  return (
    host.has(cuaAppKey(id)) ||
    EXCLUDED_BUNDLE_IDS.has(id.toLowerCase()) ||
    EXCLUDED_NAME.test(app.name ?? "") ||
    EXCLUDED_NAME.test(id) ||
    EXCLUDED_EXECUTABLE.test(id)
  );
}

/**
 * Whether a requested app id or name is one the driver never touches (a credential store, the
 * driver itself), judged without a listing so a request can be refused when the host lists
 * nothing.
 */
export function isExcludedCuaApplication(app: string): boolean {
  return excludedCuaApplication({ name: app }, app, new Set());
}

/**
 * Listings are best effort: absence must be judged against every identity the host attests,
 * including the executable when an installed-app lookup loses its bundle id.
 */
export function cuaRequestableApps(
  apps: ReadonlyArray<CuaDriverListedApp>,
  hostBundleIds: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const host = new Set(hostBundleIds.map(cuaAppKey));
  const requestable = new Set<string>();
  for (const app of apps) {
    const bundle = app.bundle_id?.trim() ?? "";
    const ids = [bundle || app.name?.trim() || "", app.executable?.trim() || ""].filter(Boolean);
    if (ids.some((id) => excludedCuaApplication(app, id, host))) continue;
    for (const id of ids) requestable.add(id);
  }
  return [...requestable].sort();
}

/**
 * Adds the executable of every Linux app that shows a window and has no desktop entry, read
 * from /proc the way the driver attests it. Windowless processes (shells, servers) stay out, as
 * does this process: GOAT's own windows are never granted.
 */
async function withLinuxExecutables(
  apps: ReadonlyArray<CuaDriverListedApp>,
): Promise<ReadonlyArray<CuaDriverListedApp>> {
  const { readlink } = await import("node:fs/promises");
  return Promise.all(
    apps.map(async (app) => {
      const pid = app.pid;
      if (
        app.bundle_id?.trim() ||
        app.executable?.trim() ||
        typeof pid !== "number" ||
        !Number.isInteger(pid) ||
        pid <= 0 ||
        pid === process.pid ||
        !Array.isArray(app.windows) ||
        app.windows.length === 0
      )
        return app;
      const executable = await readlink("/proc/" + pid + "/exe").catch(() => undefined);
      // A replaced binary reads as "<path> (deleted)", which no longer names a file to grant.
      if (
        executable === undefined ||
        !executable.startsWith("/") ||
        executable.endsWith(" (deleted)")
      )
        return app;
      return { ...app, executable };
    }),
  );
}

/**
 * One spelling per app identity, for every comparison of ids and approvals: a Windows path the
 * way the driver compares it (session_manifest.rs normalize_windows_executable_path: \\?\ and
 * \\?\UNC\ prefixes off, / as \, repeated separators collapsed, case folded); any other absolute
 * path exactly, since Linux paths differ by case; a bundle id or name lowercased.
 */
export function cuaAppKey(id: string): string {
  const trimmed = id.trim();
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) return trimmed;
  let path = trimmed.replaceAll("/", "\\");
  const windowsPath = /^[A-Za-z]:\\/u.test(path) || path.startsWith("\\\\");
  if (!windowsPath) return trimmed.toLowerCase();
  if (path.toLowerCase().startsWith("\\\\?\\unc\\")) path = "\\\\" + path.slice(8);
  else if (path.startsWith("\\\\?\\")) path = path.slice(4);
  const unc = path.startsWith("\\\\");
  const parts = path.split("\\").filter((part) => part.length > 0);
  return ((unc ? "\\\\" : "") + parts.join("\\")).toLowerCase();
}

const EXECUTABLE_LINE = /^ {4}- executable: ("(?:[^"\\]|\\.)*")(?: # names: (\[.*\]))?$/u;

/**
 * Reads only the JSON-quoted app lines written by cuaDriverCapabilityManifest: each bundle id,
 * and each executable grant's path followed by the names its comment records.
 */
export function cuaDriverManifestApplications(text: string): ReadonlyArray<string> {
  const prefix = "    - bundle_id: ";
  const ids: Array<string> = [];
  for (const line of text.split("\n")) {
    if (line.startsWith(prefix)) {
      const id: unknown = JSON.parse(line.slice(prefix.length));
      if (typeof id !== "string") throw new Error("Invalid capability manifest app id.");
      ids.push(id);
      continue;
    }
    if (!line.startsWith("    - executable: ")) continue;
    const match = EXECUTABLE_LINE.exec(line);
    if (match === null) throw new Error("Invalid capability manifest executable.");
    const executable: unknown = JSON.parse(match[1] ?? "");
    const names: unknown = match[2] === undefined ? [] : JSON.parse(match[2]);
    if (
      typeof executable !== "string" ||
      !Array.isArray(names) ||
      !names.every((name) => typeof name === "string")
    )
      throw new Error("Invalid capability manifest executable.");
    ids.push(executable, ...names);
  }
  return ids;
}

/** Approved identities not yet admitted by the manifest, with driver path normalization. */
export function missingCuaDriverApplications(
  approved: ReadonlyArray<string>,
  admitted: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const present = new Set(admitted.map(cuaAppKey));
  return approved.filter((id) => !present.has(cuaAppKey(id)));
}

/**
 * v3 manifest text; JSON strings are valid YAML scalars, so every value is JSON-quoted. With
 * kill_app, apps can be force-quit only in a process launch_app started in the same driver
 * session (session_manifest.rs TerminationGrant::DriverLaunched); standard mode refuses any other
 * process before the manifest is read (tool.rs foreign_process_termination_denied).
 */
export function cuaDriverCapabilityManifest(input: {
  readonly applications: ReadonlyArray<CuaDriverAdmittedApp>;
  readonly tools?: ReadonlyArray<string>;
}): string {
  const q = (value: string) => JSON.stringify(value);
  const tools: ReadonlyArray<string> = input.tools ?? CUA_DRIVER_ALLOWED_TOOLS;
  const terminate = tools.includes("kill_app") ? ['      terminate: "driver_launched"'] : [];
  const app = (entry: CuaDriverAdmittedApp) => [
    typeof entry === "string"
      ? "    - bundle_id: " + q(entry)
      : "    - executable: " + q(entry.executable) + " # names: " + JSON.stringify(entry.names),
    ...terminate,
  ];
  return [
    "# Written by GOAT at each driver start. See ADR-0022.",
    "version: 3",
    "resources:",
    "  desktop:",
    "    display: true",
    ...(input.applications.length === 0
      ? ["  apps: []"]
      : ["  apps:", ...input.applications.flatMap(app)]),
    "allow:",
    "  tools:",
    ...tools.map((tool) => "    - " + q(tool)),
    "",
  ].join("\n");
}

const LIST_APPS_TIMEOUT_MS = 15_000;

/**
 * Asks a short-lived driver process for its own list_apps, before the shared daemon starts with
 * the manifest. macOS needs --direct to own the runtime in this process instead of reaching for a
 * daemon; listing apps reads LaunchServices and needs no grant.
 */
export function listCuaDriverApplications(input: {
  readonly binaryPath: string;
  readonly platform: NodeJS.Platform;
  readonly environment: Readonly<Record<string, string>>;
  /** Ends the listing and its driver when the asker no longer waits for it. */
  readonly signal?: AbortSignal;
}): Promise<ReadonlyArray<CuaDriverListedApp>> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(
      input.binaryPath,
      input.platform === "darwin" ? ["mcp", "--direct"] : ["mcp"],
      { stdio: ["pipe", "pipe", "ignore"], env: { ...input.environment }, windowsHide: true },
    );
    let settled = false;
    let closeLines = () => {};
    const onAbort = () => finish(new Error("Cua Driver listing was cancelled."));
    const finish = (error: Error | undefined, apps?: ReadonlyArray<CuaDriverListedApp>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      closeLines();
      // A caller may reuse one signal for many listings; each listing removes its own handler.
      input.signal?.removeEventListener("abort", onAbort);
      child.stdin.end();
      child.kill();
      if (error) reject(error);
      else resolve(apps ?? []);
    };
    // @effect-diagnostics-next-line globalTimers:off -- a plain Promise API; see the import above.
    const timer = setTimeout(
      () => finish(new Error("Cua Driver did not list apps in time.")),
      LIST_APPS_TIMEOUT_MS,
    );
    const send = (message: object) => child.stdin.write(JSON.stringify(message) + "\n");
    child.on("error", (error) => finish(error));
    // A driver that exits before reading leaves the pipe closed: that write fails here, not
    // as an uncaught error in the process that asked for the listing.
    child.stdin.on("error", (error) => finish(error));
    if (input.signal?.aborted) onAbort();
    else input.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("exit", (code) =>
      finish(new Error("Cua Driver exited while listing apps (" + code + ").")),
    );
    const lines = new BoundedLines(child.stdout, 8 * 1024 * 1024);
    closeLines = () => lines.close();
    if (settled) {
      lines.close();
      return;
    }
    lines.on("limit", () => finish(new Error("Cua Driver listing exceeded its frame budget.")));
    lines.on("line", (raw: string) => {
      const line = raw.trim();
      if (line.length === 0) return;
      let message: {
        id?: unknown;
        result?: { structuredContent?: { apps?: unknown }; isError?: boolean };
        error?: unknown;
      };
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.id === 1) {
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
        send({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "list_apps", arguments: {} },
        });
      } else if (message.id === 2) {
        const apps = message.result?.structuredContent?.apps;
        if (message.error !== undefined || message.result?.isError === true || !Array.isArray(apps))
          finish(new Error("Cua Driver could not list apps."));
        else finish(undefined, apps as ReadonlyArray<CuaDriverListedApp>);
      }
    });
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "goat", version: "1" },
      },
    });
  });
}

/** Replaces the manifest owner-only; direct agent connections can read it during refresh. */
export async function writeCuaDriverCapabilityManifest(
  path: string,
  text: string,
): Promise<string> {
  const { mkdir, mkdtemp, rename, rm, writeFile } = await import("node:fs/promises");
  const { dirname, join } = await import("node:path");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(join(dirname(path), ".manifest-"));
  try {
    const contents = join(temporary, "contents.yaml");
    await writeFile(contents, text, { mode: 0o600 });
    // The desktop mutex cannot fence a direct helper connection in another process.
    await rename(contents, path);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return path;
}

/** Lists the driver's apps, admits them as above, and writes the agents' manifest. */
interface CuaDriverListingInput {
  readonly binaryPath: string;
  readonly platform: NodeJS.Platform;
  readonly environment: Readonly<Record<string, string>>;
  readonly hostBundleIds: ReadonlyArray<string>;
  /** Lists apps through a helper that verifies the driver first, instead of running it here. */
  readonly listApplications?: () => Promise<ReadonlyArray<CuaDriverListedApp>>;
  readonly signal?: AbortSignal;
}

/** The driver's apps with the identities GOAT judges them by, and the host's own to exclude. */
async function listForHost(input: CuaDriverListingInput) {
  const listed = await (input.listApplications?.() ?? listCuaDriverApplications(input));
  const linux = input.platform === "linux";
  const apps = linux ? await withLinuxExecutables(listed) : listed;
  const { realpath } = await import("node:fs/promises");
  // GOAT's own runtime (node or Electron) is never granted by its executable.
  const self = linux ? await realpath(process.execPath).catch(() => process.execPath) : undefined;
  return { apps, host: self === undefined ? input.hostBundleIds : [...input.hostBundleIds, self] };
}

export async function prepareCuaDriverCapabilityManifest(
  input: CuaDriverListingInput & { readonly path: string },
): Promise<string> {
  const listed = await listForHost(input);
  const apps = input.platform === "darwin" ? await withBundleExecutables(listed.apps) : listed.apps;
  return writeCuaDriverCapabilityManifest(
    input.path,
    cuaDriverCapabilityManifest({ applications: admittedCuaApplications(apps, listed.host) }),
  );
}

const PLIST_EXECUTABLE = /<key>CFBundleExecutable<\/key>\s*<string>([^<]*)<\/string>/u;
const XML_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/**
 * Adds the binary of each listed macOS app bundle, named by its Info.plist and resolved the way
 * the driver canonicalizes a manifest path. An app whose binary cannot be read keeps only its
 * bundle id grant, so kill_app stays refused for it; nothing here can fail the listing.
 */
async function withBundleExecutables(
  apps: ReadonlyArray<CuaDriverListedApp>,
): Promise<ReadonlyArray<CuaDriverListedApp>> {
  const { readFile, realpath, stat } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const executableName = async (plist: string) => {
    const bytes = await readFile(plist);
    if (bytes.subarray(0, 6).toString("latin1") === "bplist") {
      const output = await new Promise<string>((resolve, reject) =>
        NodeChildProcess.execFile(
          "/usr/bin/plutil",
          ["-extract", "CFBundleExecutable", "raw", "-o", "-", plist],
          { timeout: 5_000 },
          (error, stdout) => (error ? reject(error) : resolve(stdout)),
        ),
      );
      return output.trim();
    }
    const raw = PLIST_EXECUTABLE.exec(bytes.toString("utf8"))?.[1] ?? "";
    return raw
      .replaceAll(/&(amp|lt|gt|quot|apos);/gu, (_, entity: string) => XML_ENTITIES[entity] ?? "")
      .trim();
  };
  return Promise.all(
    apps.map(async (app) => {
      const bundle = app.launch_path?.trim() ?? "";
      if (!app.bundle_id?.trim() || !bundle.startsWith("/") || !bundle.endsWith(".app")) return app;
      const name = await executableName(join(bundle, "Contents", "Info.plist")).catch(() => "");
      if (name === "" || name === "." || name === ".." || name.includes("/")) return app;
      const binary = await realpath(join(bundle, "Contents", "MacOS", name)).catch(() => "");
      const file =
        binary !== "" &&
        (await stat(binary).then(
          (s) => s.isFile(),
          () => false,
        ));
      return file ? { ...app, bundle_executable: binary } : app;
    }),
  );
}

/**
 * The app names an approval request may use on a host whose server runs the driver itself
 * (#1561): the same listing and identities the manifest is built from, read when asked.
 */
export async function listCuaRequestableApplications(
  input: CuaDriverListingInput,
): Promise<ReadonlyArray<string>> {
  const { apps, host } = await listForHost(input);
  // On Linux the manifest grants only a desktop entry or an attested executable, and never this
  // process, so a name with neither, or GOAT's own, is not an app a request can be granted.
  const grantable =
    input.platform === "linux"
      ? apps.filter(
          (app) =>
            app.pid !== process.pid && Boolean(app.bundle_id?.trim() || app.executable?.trim()),
        )
      : apps;
  return cuaRequestableApps(grantable, host);
}

/**
 * The environment a request-time listing runs in: the listing allowlist, then the probed
 * display. On Linux a session variable the probe left out is passed empty, as the daemon gets
 * it, so a listing never reaches a session the probe found unusable.
 */
export function cuaDriverSessionListingEnvironment(
  base: Readonly<Record<string, string | undefined>>,
  display: ReadonlyArray<{ readonly name: string; readonly value: string }>,
  platform: NodeJS.Platform,
): Record<string, string> {
  const environment = cuaDriverListingEnvironment(base);
  for (const { name, value } of display) environment[name] = value;
  if (platform === "linux")
    for (const name of CUA_DRIVER_PROBED_SESSION_NAMES)
      if (!display.some((variable) => variable.name === name)) environment[name] = "";
  return environment;
}

/** What the desktop's macOS grant check calls on GOAT's own window, and nothing else. */
export const CUA_DRIVER_VERIFY_TOOLS = [
  "check_permissions",
  "health_report",
  "list_windows",
  "get_window_state",
] as const;

/**
 * The driver validates its manifest and permission mode before it listens and exits with status
 * 64 when either is wrong. The SDK reports only that exit; the reason stays on the inherited
 * stderr, so hosts name the cause instead of a generic start failure.
 */
export function isCuaDriverStartupRefusal(cause: unknown): boolean {
  let current: unknown = cause;
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth++) {
    const text = current instanceof Error ? current.message : String(current);
    if (/exited before readiness \(code=Some\(64\)\)/u.test(text)) return true;
    current =
      typeof current === "object" && "cause" in current
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
  return false;
}
