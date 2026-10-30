/**
 * Which app a driver call acts on, judged against the apps a thread may control. The proxy runs
 * it before forwarding every tools/call when the thread's control names apps; a control without
 * a list allows every app the driver's own manifest admits.
 *
 * A call is tied to an app by the pid it targets, either top level or in an exact window target.
 * Calls without one act on whatever the desktop shows, so they do not run under a list. Scripts
 * and batches cannot be read ahead of time, so they run under a list only with an `app_scope` of
 * approved apps, which the driver enforces on each call they make (ComputerUseBatchScope). The
 * driver's own answers say which app a pid is.
 *
 * @module ComputerUseScope
 */
import { cuaAppKey, isExcludedCuaApplication } from "@goat/shared/cuaDriverManifest";

import { backgroundBatch, batchAppScope } from "./ComputerUseBatchScope.ts";
import { foreground } from "./ComputerUseCallReservations.ts";
import { movesPointer } from "./computerUseTarget.ts";

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
  "get_config",
  "set_agent_cursor_enabled",
  "set_agent_cursor_motion",
  "set_agent_cursor_theme",
]);

/** Run steps or code the proxy cannot attribute to one app before they start. */
const OPAQUE_TOOLS: ReadonlySet<string> = new Set(["run_steps", "run_script"]);

/** Tools that bring a window forward whatever delivery they name. */
const SCREEN_TOOLS: ReadonlySet<string> = new Set(["bring_to_front"]);

export interface ListedApp {
  readonly id: string;
  readonly name: string | undefined;
  /** The bundle id list_apps reported, apart from an id that is only the app's name. */
  readonly bundleId?: string;
  /**
   * The executable an app without a bundle id runs, which a request may name it by instead: the
   * Windows helper's listing gives it, a Linux proxy reads it from /proc.
   */
  readonly executable?: string;
}

export type ScopeVerdict =
  | {
      readonly _tag: "allow";
      /** Allowed only by the executable the pid ran when last listed, which a caller confirms. */
      readonly byExecutable?: { readonly pid: number; readonly executable: string };
    }
  /** The pid's app is not known yet; list the apps and judge again. */
  | { readonly _tag: "resolve"; readonly pid: number }
  | {
      readonly _tag: "refuse";
      readonly reason: "app_not_approved" | "app_not_allowed" | "desktop_not_approved";
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

export const targetPid = (args: Readonly<Record<string, unknown>> | undefined) => {
  const pid = args?.pid ?? record(args?.target)?.pid;
  return typeof pid === "number" && Number.isInteger(pid) ? pid : undefined;
};

/**
 * Whether a call takes the screen itself: it brings a window forward, moves the pointer, or
 * delivers input in the foreground. A script or batch cannot be read for that, so it counts
 * unless it is a run_steps whose app scope keeps it to background delivery. Background delivery posts to the target
 * process without either, which is what lets threads admitted to different apps act at once.
 */
export function takesScreen(name: unknown, args: unknown): boolean {
  // Window/default moves leave the real pointer alone, even with foreground delivery (#1501).
  if (name === "move_cursor") return movesPointer(args);
  if (typeof name === "string" && SCREEN_TOOLS.has(name)) return true;
  if (typeof name === "string" && OPAQUE_TOOLS.has(name))
    return !backgroundBatch(name, args) || foreground(args);
  // The same foreground test as window reservations (#1462), so both agree on what takes it.
  return foreground(args);
}

/** The one spelling every comparison of app ids and approvals uses; see cuaAppKey. */
export const appKey = cuaAppKey;

const approves = (apps: ReadonlySet<string>, ...names: ReadonlyArray<string | undefined>) =>
  names.some((name) => name !== undefined && apps.has(appKey(name)));

/** The apps a control allows, each by appKey; undefined allows every app. */
export const approvedApps = (apps: ReadonlyArray<string> | undefined) =>
  apps === undefined ? undefined : new Set(apps.map(appKey));

export function scopeVerdict(input: {
  readonly name: unknown;
  readonly args: unknown;
  readonly apps: ReadonlySet<string> | undefined;
  readonly appOf: (pid: number) => ListedApp | undefined;
  /** This host's apps have bundle ids (macOS), which is what grants name them by. */
  readonly bundleIds: boolean;
}): ScopeVerdict {
  const approved = input.apps;
  if (typeof input.name === "string" && UNSCOPED_TOOLS.has(input.name)) return { _tag: "allow" };
  const args = record(input.args);
  const pid = targetPid(args);
  const target = pid === undefined ? undefined : input.appOf(pid);
  const named = text(args?.bundle_id) ?? text(args?.name) ?? text(args?.app_name);
  const protectedApp = [target?.id, target?.name, target?.executable, named].find(
    (value) => value !== undefined && isExcludedCuaApplication(value),
  );
  if (protectedApp !== undefined)
    return { _tag: "refuse", reason: "app_not_allowed", app: protectedApp };
  if (typeof input.name === "string" && OPAQUE_TOOLS.has(input.name)) {
    const denied = batchAppScope(input.name, input.args)?.apps.find(isExcludedCuaApplication);
    if (denied !== undefined) return { _tag: "refuse", reason: "app_not_allowed", app: denied };
  }
  if (typeof input.name === "string" && OPAQUE_TOOLS.has(input.name) && approved === undefined) {
    const scope = batchAppScope(input.name, input.args);
    return scope !== undefined && !scope.apps.some(isExcludedCuaApplication)
      ? { _tag: "allow" }
      : { _tag: "refuse", reason: "desktop_not_approved", opaque: true };
  }
  if (
    pid !== undefined &&
    target === undefined &&
    (typeof input.name !== "string" || !OPAQUE_TOOLS.has(input.name))
  )
    return { _tag: "resolve", pid };
  if (approved === undefined) return { _tag: "allow" };
  const name = typeof input.name === "string" ? input.name : "";
  if (OPAQUE_TOOLS.has(name)) {
    // The driver refuses each call the batch makes outside its scope, so approved apps suffice.
    const scope = batchAppScope(name, input.args);
    return scope !== undefined && scope.apps.every((app) => approves(approved, app))
      ? { _tag: "allow" }
      : { _tag: "refuse", reason: "desktop_not_approved", opaque: true };
  }
  if (name === "launch_app") {
    // The driver picks what to open from a name, a path, an AUMID or URLs before any id a grant
    // names (cua-driver v0.37.0); on Linux and Windows those can open an app another thread's
    // grant holds, so only macOS, where a bundle id picks exactly one app, launches under a list.
    if (!input.bundleIds)
      return { _tag: "refuse", reason: "app_not_approved", launch: "unverifiable" };
    const bundle = text(args?.bundle_id);
    const launchName = text(args?.name) ?? text(args?.app_name);
    if (bundle === undefined || launchName !== undefined)
      return { _tag: "refuse", reason: "app_not_approved", launch: "bundle_id" };
    return approves(approved, bundle)
      ? { _tag: "allow" }
      : { _tag: "refuse", reason: "app_not_approved", app: bundle };
  }
  if (pid === undefined) return { _tag: "refuse", reason: "desktop_not_approved" };
  const app = input.appOf(pid);
  if (app === undefined) return { _tag: "resolve", pid };
  // Only the id list_apps reports counts, or the exact executable it runs: a display name would
  // let two grants that name the same app differently both reach it.
  if (approves(approved, app.id)) return { _tag: "allow" };
  return app.executable !== undefined && approves(approved, app.executable)
    ? { _tag: "allow", byExecutable: { pid, executable: app.executable } }
    : { _tag: "refuse", reason: "app_not_approved", app: app.id };
}

/** The spelling of an app a control's grant names it by, for the app lease its calls hold. */
export const grantedAppId = (app: ListedApp, apps: ReadonlySet<string> | undefined) =>
  apps !== undefined && !approves(apps, app.id) && approves(apps, app.executable)
    ? (app.executable ?? app.id)
    : app.id;

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
export function learnApps(
  value: unknown,
  into: Map<number, ListedApp>,
  listing: boolean,
  executableOf?: (pid: number) => string | undefined,
  /** Every app an answer names, for the timeline only. */
  labels?: { readonly learn: (entries: ReadonlyArray<NamedApp>) => void },
): void {
  const entries = listing ? listedApps(value) : namedApps(value);
  labels?.learn(entries);
  for (const entry of entries) {
    if (listing) {
      const executable =
        entry.executable ?? (entry.bundleId === undefined ? executableOf?.(entry.pid) : undefined);
      into.set(entry.pid, {
        id: entry.id,
        name: entry.name,
        ...(entry.bundleId === undefined ? {} : { bundleId: entry.bundleId }),
        ...(executable === undefined ? {} : { executable }),
      });
    } else {
      // A reply naming another app or binary for the pid makes it unknown until listed again.
      const known = into.get(entry.pid);
      if (
        known?.id !== entry.id ||
        (entry.executable !== undefined &&
          known.executable !== undefined &&
          appKey(entry.executable) !== appKey(known.executable))
      )
        into.delete(entry.pid);
    }
  }
}

interface NamedApp extends ListedApp {
  readonly pid: number;
}

const namedApp = (value: unknown): NamedApp | undefined => {
  const object = record(value);
  const pid = object?.pid;
  const name = text(object?.app_name) ?? text(object?.name);
  const bundleId = text(object?.bundle_id);
  const executable = text(object?.executable);
  const id = bundleId ?? name;
  return typeof pid === "number" && Number.isInteger(pid) && id !== undefined
    ? {
        pid,
        id,
        name,
        ...(bundleId === undefined ? {} : { bundleId }),
        ...(executable === undefined ? {} : { executable }),
      }
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
