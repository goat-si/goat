/**
 * The `app_scope` of a run_steps or run_script call (cua-driver goat.6+): the driver checks every
 * call the batch makes against it and refuses one outside it with nothing sent. A malformed scope
 * reads as none, as the driver refuses it, so GOAT judges that batch as unscoped desktop work.
 */

const BATCH_TOOLS: ReadonlySet<string> = new Set(["run_steps", "run_script"]);
/** The driver's MAX_SCOPE_APPS (cua-driver-core batch_scope.rs). */
export const MAX_BATCH_SCOPE_APPS = 32;

interface BatchAppScope {
  readonly apps: ReadonlyArray<string>;
  /** Background (the driver's default) posts to the scoped windows only; foreground may raise them. */
  readonly delivery: "background" | "foreground";
}

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

export const isBatchTool = (name: unknown): name is string =>
  typeof name === "string" && BATCH_TOOLS.has(name);

export function batchAppScope(name: unknown, args: unknown): BatchAppScope | undefined {
  if (!isBatchTool(name)) return undefined;
  const scope = record(record(args)?.app_scope);
  if (scope === undefined || Object.keys(scope).some((key) => key !== "apps" && key !== "delivery"))
    return undefined;
  const apps: unknown = scope.apps;
  if (
    !Array.isArray(apps) ||
    apps.length === 0 ||
    apps.length > MAX_BATCH_SCOPE_APPS ||
    !apps.every((app) => typeof app === "string" && app.length > 0 && app.trim() === app)
  )
    return undefined;
  const delivery =
    scope.delivery === undefined || scope.delivery === null || scope.delivery === "background"
      ? "background"
      : scope.delivery === "foreground"
        ? "foreground"
        : undefined;
  return delivery === undefined ? undefined : { apps: apps as ReadonlyArray<string>, delivery };
}

/**
 * A run_steps the driver keeps to background delivery in its scoped apps. run_script never counts:
 * a scope admits a launch of a scoped app inside it, which a direct launch_app needs foreground
 * approval for.
 */
export const backgroundBatch = (name: unknown, args: unknown) =>
  name === "run_steps" && batchAppScope(name, args)?.delivery === "background";

const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
/** Fields with which a run_steps step or its arguments can name a window of their own. */
const WINDOW_FIELDS = ["pid", "window_id", "app", "window", "target"] as const;

/**
 * The one window a run_steps call acts in: its own pid and window_id, when nothing in its steps
 * names another. A check (wait_for, expect) that names a window also moves the window later steps
 * inherit, so it counts. Any other batch may act in any window of its scoped apps: desktop work.
 */
export function batchWindow(
  name: unknown,
  args: unknown,
): { readonly pid: number; readonly windowId: number } | undefined {
  if (name !== "run_steps") return undefined;
  const batch = record(args);
  const pid = batch?.pid;
  const windowId = batch?.window_id;
  if (
    !positive(pid) ||
    !positive(windowId) ||
    batch?.app !== undefined ||
    batch?.window !== undefined
  )
    return undefined;
  const steps = batch?.steps;
  if (!Array.isArray(steps)) return undefined;
  // Every object a step holds, at any depth, names no window but the batch's own.
  const own = (value: unknown, depth: number): boolean => {
    if (depth > 8) return false;
    if (Array.isArray(value)) return value.every((item) => own(item, depth + 1));
    const fields = record(value);
    if (fields === undefined) return true;
    return (
      WINDOW_FIELDS.every(
        (field) =>
          fields[field] === undefined ||
          (field === "pid" && fields[field] === pid) ||
          (field === "window_id" && fields[field] === windowId),
      ) && Object.values(fields).every((nested) => own(nested, depth + 1))
    );
  };
  return own(steps, 0) ? { pid, windowId } : undefined;
}
