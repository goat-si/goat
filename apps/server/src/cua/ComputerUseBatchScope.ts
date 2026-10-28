/**
 * The `app_scope` a run_steps or run_script call carries (cua-driver goat.6+). The driver checks
 * every call the batch makes against it, including the reads that find a target, and refuses one
 * outside it with nothing sent, so GOAT can admit the batch for those apps without reading it
 * ahead. A malformed scope reads as none: the driver refuses it, and GOAT judges the batch as the
 * unscoped desktop work it would otherwise be.
 *
 * @module ComputerUseBatchScope
 */

const BATCH_TOOLS: ReadonlySet<string> = new Set(["run_steps", "run_script"]);
/** The driver's MAX_SCOPE_APPS (cua-driver-core batch_scope.rs). */
export const MAX_BATCH_SCOPE_APPS = 32;

export interface BatchAppScope {
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

const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
/** Fields with which a run_steps step or its arguments can name a window of their own. */
const WINDOW_FIELDS = ["pid", "window_id", "app", "window", "target"] as const;

/**
 * The one window a run_steps call acts in: its own pid and window_id, when no step names another.
 * Checks (wait_for, expect) only read. Any other batch may act in any window of its scoped apps,
 * so it is judged as desktop work.
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
  const own = (fields: Readonly<Record<string, unknown>>) =>
    WINDOW_FIELDS.every(
      (field) =>
        fields[field] === undefined ||
        (field === "pid" && fields[field] === pid) ||
        (field === "window_id" && fields[field] === windowId),
    );
  for (const step of steps) {
    const entry = record(step);
    if (entry === undefined || !own(entry)) return undefined;
    for (const [key, value] of Object.entries(entry)) {
      if (key === "wait_for" || key === "expect") continue;
      const fields = record(value);
      if (fields !== undefined && !own(fields)) return undefined;
    }
  }
  return { pid, windowId };
}
