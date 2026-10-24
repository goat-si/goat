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

/** The window a call's arguments name, or undefined for a desktop, app or unnamed target. */
export function targetOf(args: unknown): ComputerUseCallTarget | undefined {
  const top = record(args);
  const target = record(top?.target);
  const pid = integer(top?.pid) ?? integer(target?.pid);
  const windowId = integer(top?.window_id) ?? integer(target?.window_id);
  return pid === undefined || windowId === undefined ? undefined : { pid, windowId };
}
