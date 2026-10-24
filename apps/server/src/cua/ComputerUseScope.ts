/**
 * Which app a driver call acts on, judged against the apps a thread may control. The proxy runs
 * it before forwarding every tools/call when the thread's control names apps; a control without
 * a list allows every app the driver's own manifest admits.
 *
 * A call is tied to an app by the pid it targets, either top level or in an exact window target.
 * Calls without one act on whatever the desktop shows, and scripts or batches cannot be read
 * ahead of time, so neither runs under a list. The driver's own answers say which app a pid is.
 *
 * @module ComputerUseScope
 */
import { foreground } from "./ComputerUseCallReservations.ts";

/** Reads and session bookkeeping that touch no app's contents or input. */
const UNSCOPED_TOOLS: ReadonlySet<string> = new Set([
  "check_permissions",
  "health_report",
  "get_guide",
  "list_apps",
  "list_windows",
  "get_screen_size",
  "get_cursor_position",
  "start_session",
  "end_session",
  "get_session",
  "list_sessions",
  "get_agent_cursor_state",
  "set_agent_cursor_enabled",
  "set_agent_cursor_motion",
  "set_agent_cursor_theme",
]);

/** Run steps or code the proxy cannot attribute to one app before they start. */
const OPAQUE_TOOLS: ReadonlySet<string> = new Set(["run_steps", "run_script"]);

/** Tools that bring a window forward or move the pointer whatever delivery they name. */
const SCREEN_TOOLS: ReadonlySet<string> = new Set(["bring_to_front", "move_cursor"]);

export interface ListedApp {
  readonly id: string;
  readonly name: string | undefined;
}

export type ScopeVerdict =
  | { readonly _tag: "allow" }
  /** The pid's app is not known yet; list the apps and judge again. */
  | { readonly _tag: "resolve"; readonly pid: number }
  | {
      readonly _tag: "refuse";
      readonly reason: "app_not_approved" | "desktop_not_approved";
      readonly app?: string;
      readonly opaque?: boolean;
      /**
       * A launch the proxy cannot tie to an approved app: on macOS one not named by bundle id
       * alone, elsewhere any launch.
       */
      readonly launch?: "bundle_id" | "unverifiable";
    };

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

const text = (value: unknown) =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const targetPid = (args: Readonly<Record<string, unknown>> | undefined) => {
  const pid = args?.pid ?? record(args?.target)?.pid;
  return typeof pid === "number" && Number.isInteger(pid) ? pid : undefined;
};

/**
 * Whether a call takes the screen itself: it brings a window forward, moves the pointer, or
 * delivers input in the foreground. A script or batch cannot be read for that, so it counts. Background delivery posts to the target process without
 * either, which is what lets threads admitted to different apps act at once.
 */
export function takesScreen(name: unknown, args: unknown): boolean {
  if (typeof name === "string" && (SCREEN_TOOLS.has(name) || OPAQUE_TOOLS.has(name))) return true;
  // The same foreground test as window reservations (#1462), so both agree on what takes it.
  return foreground(args);
}

const approves = (apps: ReadonlySet<string>, ...names: ReadonlyArray<string | undefined>) =>
  names.some((name) => name !== undefined && apps.has(name.toLowerCase()));

/** The apps a control allows, as a lowercase set; undefined allows every app. */
export const approvedApps = (apps: ReadonlyArray<string> | undefined) =>
  apps === undefined ? undefined : new Set(apps.map((app) => app.toLowerCase()));

export function scopeVerdict(input: {
  readonly name: unknown;
  readonly args: unknown;
  readonly apps: ReadonlySet<string> | undefined;
  readonly appOf: (pid: number) => ListedApp | undefined;
  /** This host's apps have bundle ids (macOS), which is what grants name them by. */
  readonly bundleIds: boolean;
}): ScopeVerdict {
  if (input.apps === undefined) return { _tag: "allow" };
  const name = typeof input.name === "string" ? input.name : "";
  if (UNSCOPED_TOOLS.has(name)) return { _tag: "allow" };
  if (OPAQUE_TOOLS.has(name))
    return { _tag: "refuse", reason: "desktop_not_approved", opaque: true };
  const args = record(input.args);
  if (name === "launch_app") {
    // The driver picks what to open from a name, a path, an AUMID or URLs before any id a grant
    // names (cua-driver v0.37.0); on Linux and Windows those can open an app another thread's
    // grant holds, so only macOS, where a bundle id picks exactly one app, launches under a list.
    if (!input.bundleIds)
      return { _tag: "refuse", reason: "app_not_approved", launch: "unverifiable" };
    const bundle = text(args?.bundle_id);
    const named = text(args?.name) ?? text(args?.app_name);
    if (bundle === undefined || named !== undefined)
      return { _tag: "refuse", reason: "app_not_approved", launch: "bundle_id" };
    return approves(input.apps, bundle)
      ? { _tag: "allow" }
      : { _tag: "refuse", reason: "app_not_approved", app: bundle };
  }
  const pid = targetPid(args);
  if (pid === undefined) return { _tag: "refuse", reason: "desktop_not_approved" };
  const app = input.appOf(pid);
  if (app === undefined) return { _tag: "resolve", pid };
  // Only the id list_apps reports counts: a display name would let two grants that name the
  // same app differently both reach it, and grants are told apart by these strings alone.
  return approves(input.apps, app.id)
    ? { _tag: "allow" }
    : { _tag: "refuse", reason: "app_not_approved", app: app.id };
}

/**
 * Keeps the pid-to-app map in step with a driver answer. Only a list_apps answer (`listing`)
 * says which app a pid is, and only through the entries of its `apps` arrays: each names its
 * app by the bundle id grants name, or the app name where there is none. Everything else names
 * apps without the bundle id: windows an entry nests, the `processes` list Windows and Linux
 * drivers send beside `apps`, and answers such as list_windows and get_window_state. A display
 * name taken as an id would let a grant naming it reach an app another grant names by bundle
 * id, so outside a listing an answer can only drop a pid whose app it names differently, which
 * also catches a pid reused by another app; the pid is listed again before it is judged.
 */
export function learnApps(value: unknown, into: Map<number, ListedApp>, listing: boolean): void {
  for (const entry of listing ? listedApps(value) : namedApps(value)) {
    if (listing) into.set(entry.pid, { id: entry.id, name: entry.name });
    else if (into.get(entry.pid)?.id !== entry.id) into.delete(entry.pid);
  }
}

interface NamedApp extends ListedApp {
  readonly pid: number;
}

const namedApp = (value: unknown): NamedApp | undefined => {
  const object = record(value);
  const pid = object?.pid;
  const name = text(object?.app_name) ?? text(object?.name);
  const id = text(object?.bundle_id) ?? name;
  return typeof pid === "number" && Number.isInteger(pid) && id !== undefined
    ? { pid, id, name }
    : undefined;
};

/** The entries of every `apps` array in a list_apps answer, wherever its envelope puts them. */
function listedApps(value: unknown, depth = 0): ReadonlyArray<NamedApp> {
  if (depth > 5) return [];
  if (Array.isArray(value)) return value.flatMap((item) => listedApps(item, depth + 1));
  const object = record(value);
  if (object === undefined) return [];
  return Object.entries(object).flatMap(([key, nested]) =>
    key === "apps" && Array.isArray(nested)
      ? nested.flatMap((item) => namedApp(item) ?? [])
      : typeof nested === "object" && nested !== null
        ? listedApps(nested, depth + 1)
        : [],
  );
}

/** Every object in an answer that names an app with its pid. */
function namedApps(value: unknown, depth = 0): ReadonlyArray<NamedApp> {
  if (depth > 5) return [];
  if (Array.isArray(value)) return value.flatMap((item) => namedApps(item, depth + 1));
  const object = record(value);
  if (object === undefined) return [];
  const own = namedApp(object);
  return [
    ...(own === undefined ? [] : [own]),
    ...Object.values(object).flatMap((nested) =>
      typeof nested === "object" && nested !== null ? namedApps(nested, depth + 1) : [],
    ),
  ];
}
