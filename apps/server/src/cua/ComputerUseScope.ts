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
 * delivers input in the foreground. Background delivery posts to the target process without
 * either, which is what lets threads admitted to different apps act at once.
 */
export function takesScreen(name: unknown, args: unknown): boolean {
  if (typeof name === "string" && SCREEN_TOOLS.has(name)) return true;
  const object = record(args);
  return (
    object?.delivery_mode === "foreground" || record(object?.target)?.delivery_mode === "foreground"
  );
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
}): ScopeVerdict {
  if (input.apps === undefined) return { _tag: "allow" };
  const name = typeof input.name === "string" ? input.name : "";
  if (UNSCOPED_TOOLS.has(name)) return { _tag: "allow" };
  if (OPAQUE_TOOLS.has(name))
    return { _tag: "refuse", reason: "desktop_not_approved", opaque: true };
  const args = record(input.args);
  if (name === "launch_app") {
    const app = text(args?.bundle_id) ?? text(args?.name) ?? text(args?.app_name);
    return app !== undefined && approves(input.apps, app)
      ? { _tag: "allow" }
      : { _tag: "refuse", reason: "app_not_approved", ...(app === undefined ? {} : { app }) };
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
 * says which app a pid is, by the bundle id grants name or the app name where there is none.
 * Other answers, such as list_windows and get_window_state, often name the app without its
 * bundle id; a display name taken as an id would let a grant naming it reach an app another
 * grant names by bundle id. They can only drop a pid whose app they name differently, which
 * also catches a pid reused by another app, so it is listed again before it is judged.
 */
export function learnApps(
  value: unknown,
  into: Map<number, ListedApp>,
  listing: boolean,
  depth = 0,
): void {
  if (depth > 5) return;
  if (Array.isArray(value)) {
    for (const item of value) learnApps(item, into, listing, depth + 1);
    return;
  }
  const object = record(value);
  if (object === undefined) return;
  const pid = object.pid;
  const name = text(object.app_name) ?? text(object.name);
  const id = text(object.bundle_id) ?? name;
  if (typeof pid === "number" && Number.isInteger(pid) && id !== undefined) {
    if (listing) into.set(pid, { id, name });
    else if (into.get(pid)?.id !== id) into.delete(pid);
  }
  for (const nested of Object.values(object))
    if (typeof nested === "object" && nested !== null) learnApps(nested, into, listing, depth + 1);
}
