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
  if (approves(input.apps, app.id, app.name)) return { _tag: "allow" };
  // Known only by a name, such as a Linux window's process name, the pid may still have a
  // desktop id a grant names; the listing says.
  if (app.id === app.name) return { _tag: "resolve", pid };
  return { _tag: "refuse", reason: "app_not_approved", app: app.id };
}

/**
 * Records every app a driver answer names with its pid, such as list_apps, list_windows and
 * launch_app results. Ids prefer the bundle id, which is what grants name, then a window's app
 * name, then a process name. Within one answer the best of these wins for each pid: Linux
 * list_apps names each app again in the windows it nests and in a processes list (#1428).
 */
export function learnApps(value: unknown, into: Map<number, ListedApp>): void {
  const best = new Map<number, number>();
  learn(value, 0, (pid, rank) => best.set(pid, Math.max(rank, best.get(pid) ?? 0)));
  learn(value, 0, (pid, rank, bundle, name) => {
    if (rank < (best.get(pid) ?? 0)) return;
    const id = bundle ?? name;
    if (id === undefined) return;
    const known = into.get(pid);
    // Replies such as get_window_state name the app without its bundle id. A name cannot tell
    // the listed app from another that reused its pid, and keeping the name as its id would
    // refuse every grant naming the bundle id, so the pid is listed again before it is judged.
    if (bundle === undefined && known !== undefined && known.id !== known.name) into.delete(pid);
    else into.set(pid, { id, name });
  });
}

function learn(
  value: unknown,
  depth: number,
  visit: (pid: number, rank: number, bundle: string | undefined, name: string | undefined) => void,
): void {
  if (depth > 5) return;
  if (Array.isArray(value)) {
    for (const item of value) learn(item, depth + 1, visit);
    return;
  }
  const object = record(value);
  if (object === undefined) return;
  const pid = object.pid;
  if (typeof pid === "number" && Number.isInteger(pid)) {
    const bundle = text(object.bundle_id);
    const appName = text(object.app_name);
    const rank = bundle !== undefined ? 2 : appName !== undefined ? 1 : 0;
    visit(pid, rank, bundle, appName ?? text(object.name));
  }
  for (const nested of Object.values(object))
    if (typeof nested === "object" && nested !== null) learn(nested, depth + 1, visit);
}
