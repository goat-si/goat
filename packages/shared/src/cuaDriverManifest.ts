// GOAT's capability manifest for the Cua Driver daemon: a launch-time ceiling the driver
// enforces on every tool call, including calls nested inside run_steps and run_script. It
// narrows what any agent can reach through the shared daemon; it cannot judge intent (typing a
// secret into an allowed window stays possible), which is what the unattended lease is for.
// Shapes follow the v3 schema of the pinned driver (cua-driver-core/src/session_manifest.rs at
// cua-driver-rs-v0.37.0), which rejects unknown keys, unknown tools and an empty allow list.

// @effect-diagnostics-next-line nodeBuiltinImport:off -- Electron main and the standalone server both call this outside an Effect runtime.
import * as NodeChildProcess from "node:child_process";

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
  "set_window_frame",
  "run_steps",
  "run_script",
  "start_session",
  "end_session",
  "get_session",
  "list_sessions",
  "get_agent_cursor_state",
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
  get_config: "driver configuration belongs to GOAT",
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
  kill_app: "force-quits apps and loses unsaved work; the manifest grants no terminate scope",
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
 * computer use, the driver's own app, and credential stores. Matched against the bundle id
 * (case-insensitive) and the app name.
 */
const EXCLUDED_BUNDLE_IDS = new Set([
  "com.trycua.driver",
  "com.apple.keychainaccess",
  "com.apple.passwords",
  "com.1password.1password",
  "com.agilebits.onepassword7",
  "com.bitwarden.desktop",
  "org.keepassxc.keepassxc",
  "com.lastpass.lastpass",
  "com.dashlane.dashlanephonefinal",
]);
const EXCLUDED_NAME =
  /\b(1password|bitwarden|keepass(xc)?|lastpass|dashlane|keychain access|passwords)\b/iu;
/** The driver and GOAT's helper on Windows, named by their executables. */
const EXCLUDED_EXECUTABLE = /(^|[\\/])(cua-driver|GOAT Computer Use)\.exe$/iu;

export interface CuaDriverListedApp {
  readonly bundle_id?: string | null;
  readonly name?: string | null;
  /** A running app's executable path, added by the Windows helper (the driver gives none). */
  readonly executable?: string | null;
}

/**
 * Bundle ids GOAT admits for general desktop control: every app the driver itself lists (its
 * list_apps result is what it attests a window's app identity against), minus the host GOAT runs
 * in and the exclusions above. On Windows a running program with no Start menu entry has no
 * bundle id; its executable path stands in, which the driver matches against the executable it
 * attests for the window (#1368). Apps with neither stay out, so an app installed or started
 * after the driver started needs a restart of computer use.
 */
export function admittedCuaApplications(
  apps: ReadonlyArray<CuaDriverListedApp>,
  hostBundleIds: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const host = new Set(hostBundleIds.map(identityKey));
  const admitted = new Set<string>();
  for (const app of apps) {
    const id = (app.bundle_id?.trim() || app.executable?.trim()) ?? "";
    if (!id) continue;
    if (host.has(identityKey(id)) || EXCLUDED_BUNDLE_IDS.has(id.toLowerCase())) continue;
    if (
      EXCLUDED_NAME.test(app.name ?? "") ||
      EXCLUDED_NAME.test(id) ||
      EXCLUDED_EXECUTABLE.test(id)
    )
      continue;
    admitted.add(id);
  }
  return [...admitted].sort();
}

/**
 * One spelling per identity for comparing ids: a Windows path the way the driver compares it
 * (session_manifest.rs normalize_windows_executable_path: \\?\ and \\?\UNC\ prefixes off, / as
 * \, repeated separators collapsed, case folded); anything else lowercased. GOAT can run from a
 * path spelled with a prefix while the helper lists the plain form, and must still be excluded.
 */
function identityKey(id: string): string {
  let path = id.trim().replaceAll("/", "\\");
  const windowsPath = /^[A-Za-z]:\\/u.test(path) || path.startsWith("\\\\");
  if (!windowsPath) return id.trim().toLowerCase();
  if (path.toLowerCase().startsWith("\\\\?\\unc\\")) path = "\\\\" + path.slice(8);
  else if (path.startsWith("\\\\?\\")) path = path.slice(4);
  const unc = path.startsWith("\\\\");
  const parts = path.split("\\").filter((part) => part.length > 0);
  return ((unc ? "\\\\" : "") + parts.join("\\")).toLowerCase();
}

/** v3 manifest text. JSON strings are valid YAML scalars, so every value is JSON-quoted. */
export function cuaDriverCapabilityManifest(input: {
  readonly applications: ReadonlyArray<string>;
  readonly tools?: ReadonlyArray<string>;
}): string {
  const q = (value: string) => JSON.stringify(value);
  const tools = input.tools ?? CUA_DRIVER_ALLOWED_TOOLS;
  return [
    "# Written by GOAT at each driver start. See ADR-0022.",
    "version: 3",
    "resources:",
    "  desktop:",
    "    display: true",
    ...(input.applications.length === 0
      ? ["  apps: []"]
      : ["  apps:", ...input.applications.map((id) => "    - bundle_id: " + q(id))]),
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
function listCuaDriverApplications(input: {
  readonly binaryPath: string;
  readonly platform: NodeJS.Platform;
  readonly environment: Readonly<Record<string, string>>;
}): Promise<ReadonlyArray<CuaDriverListedApp>> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(
      input.binaryPath,
      input.platform === "darwin" ? ["mcp", "--direct"] : ["mcp"],
      { stdio: ["pipe", "pipe", "ignore"], env: { ...input.environment }, windowsHide: true },
    );
    let settled = false;
    let buffer = "";
    const finish = (error: Error | undefined, apps?: ReadonlyArray<CuaDriverListedApp>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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
    child.on("exit", (code) =>
      finish(new Error("Cua Driver exited while listing apps (" + code + ").")),
    );
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.length === 0) continue;
        let message: {
          id?: unknown;
          result?: { structuredContent?: { apps?: unknown }; isError?: boolean };
          error?: unknown;
        };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
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
          if (
            message.error !== undefined ||
            message.result?.isError === true ||
            !Array.isArray(apps)
          )
            finish(new Error("Cua Driver could not list apps."));
          else finish(undefined, apps as ReadonlyArray<CuaDriverListedApp>);
        }
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

/** Writes the manifest owner-only and returns its path for the driver to load at startup. */
export async function writeCuaDriverCapabilityManifest(
  path: string,
  text: string,
): Promise<string> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, text, { mode: 0o600 });
  return path;
}

/** Lists the driver's apps, admits them as above, and writes the agents' manifest. */
export async function prepareCuaDriverCapabilityManifest(input: {
  readonly binaryPath: string;
  readonly platform: NodeJS.Platform;
  readonly environment: Readonly<Record<string, string>>;
  readonly hostBundleIds: ReadonlyArray<string>;
  readonly path: string;
  /** Lists apps through a helper that verifies the driver first, instead of running it here. */
  readonly listApplications?: () => Promise<ReadonlyArray<CuaDriverListedApp>>;
}): Promise<string> {
  const apps = await (input.listApplications?.() ?? listCuaDriverApplications(input));
  return writeCuaDriverCapabilityManifest(
    input.path,
    cuaDriverCapabilityManifest({
      applications: admittedCuaApplications(apps, input.hostBundleIds),
    }),
  );
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
