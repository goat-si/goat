/**
 * Which window a driver call acts on, read from its arguments: a pid and window_id at the top
 * level or in an exact window target. The cursor overlay (#1214) and the preview's frame target
 * (#1370) both read it here, so they always agree on the window.
 *
 * @module computerUseTarget
 */

export interface ComputerUseCallTarget {
  readonly pid: number;
  readonly windowId: number;
}

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

const integer = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) ? value : undefined;

/**
 * Whether a move_cursor moves the real pointer under pinned cua-driver 0.37.0
 * (normalize_action_target): only a desktop move with no window selector. Any other form moves
 * only GOAT's overlay, or is refused before it runs: legacy desktop scope with a pid or window_id
 * becomes a window move (Linux) or a refusal, and a typed target beside any legacy field, or one
 * the driver does not accept, is refused. Keys count when present, as the driver checks them.
 */
export function movesPointer(args: unknown): boolean {
  const given = record(args);
  const has = (key: string) => given !== undefined && key in given;
  if (has("target")) {
    if (has("scope") || has("pid") || has("window_id")) return false;
    const target = record(given?.target);
    return (
      target?.kind === "desktop" &&
      target.display_id === "primary" &&
      Object.keys(target).length === 2
    );
  }
  return given?.scope === "desktop" && !has("pid") && !has("window_id");
}

/** The window a call's arguments name, or undefined for a desktop, app or unnamed target. */
export function targetOf(args: unknown): ComputerUseCallTarget | undefined {
  const top = record(args);
  const target = record(top?.target);
  const pid = integer(top?.pid) ?? integer(target?.pid);
  const windowId = integer(top?.window_id) ?? integer(target?.window_id);
  return pid === undefined || windowId === undefined ? undefined : { pid, windowId };
}
