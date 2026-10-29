/**
 * How long one driver call may run before GOAT stops waiting for it, fails that call and replaces
 * the driver, so a stuck call costs its own cap instead of the whole cell. Measured on macOS: list
 * calls stay under 0.2 s, a tree read under 0.7 s, a click or key under 0.6 s, the slowest scroll
 * 6.9 s (a reveal walk the driver will drop); each cap keeps at least 1.4x that headroom.
 */
const CAP_MS: Readonly<Record<string, number>> = {
  list_apps: 2_000,
  list_windows: 2_000,
  click: 3_000,
  right_click: 3_000,
  press_key: 3_000,
  set_value: 3_000,
  bring_to_front: 3_000,
  drag: 3_000,
  invoke_menu: 5_000,
  scroll: 10_000,
  launch_app: 15_000,
  run_steps: 60_000,
  run_script: 60_000,
};
const DEFAULT_CAP_MS = 4_000;

/** Kept back from the cell's deadline, so a capped call's error reaches the cell while it runs. */
export const CELL_RESERVE_MS = 1_500;
/** Below this, a call cannot get an answer back in time and is refused before it is queued. */
export const MIN_CALL_MS = 250;

const record = (args: unknown): Readonly<Record<string, unknown>> =>
  typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};

export const driverCallCapMs = (tool: string, args: unknown): number => {
  const given = record(args);
  if (tool === "get_window_state") return given.include_screenshot === true ? 7_000 : 4_000;
  if (tool === "verify_state")
    return (typeof given.timeout_ms === "number" ? Math.max(0, given.timeout_ms) : 0) + 2_000;
  if (tool === "type_text")
    return 4_000 + 40 * (typeof given.text === "string" ? [...given.text].length : 0);
  return CAP_MS[tool] ?? DEFAULT_CAP_MS;
};

/** The deadline one driver call gets inside a cell that ends at cellDeadline. */
export const driverCallDeadline = (
  tool: string,
  args: unknown,
  cellDeadline: number,
  now: number,
): number => Math.min(now + driverCallCapMs(tool, args), cellDeadline - CELL_RESERVE_MS);

/** A wait in whole or tenth seconds, as the guest reads it. */
export const seconds = (ms: number) => `${Number((ms / 1_000).toFixed(1))} s`;
