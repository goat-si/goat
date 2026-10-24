/**
 * Which window a driver call acts on, read from its arguments: a pid and window_id at the top
 * level or in an exact window target. The cursor overlay (#1214) and the preview's frame target
 * (#1370) both read it here, so they always agree on the window.
 *
 * @module computerUseTarget
 */

import type { NamedWindow } from "./x11WindowPlacement.ts";

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

const MAX_NAMED_NODES = 4_096;

/**
 * Every window a driver reply or request names, wherever it sits (a list, a nested target, a
 * popup). A window_id without its own pid belongs to the nearest enclosing pid. Undefined when
 * the value is too large to read whole, or names a window with no pid at all.
 */
export const namedWindows = (value: unknown): ReadonlyArray<NamedWindow> | undefined => {
  const found: Array<NamedWindow> = [];
  let nodes = 0;
  let complete = true;
  const visit = (entry: unknown, owner: number | undefined, depth: number) => {
    if (typeof entry !== "object" || entry === null) return;
    if (++nodes > MAX_NAMED_NODES || depth > 16) {
      complete = false;
      return;
    }
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item, owner, depth + 1);
      return;
    }
    const record = entry as { pid?: unknown; window_id?: unknown; bounds?: unknown };
    const pid = typeof record.pid === "number" ? record.pid : owner;
    if (typeof record.window_id === "number") {
      if (pid === undefined) complete = false;
      else {
        const bounds = record.bounds as Record<string, unknown> | undefined;
        const box =
          typeof bounds?.x === "number" &&
          typeof bounds.y === "number" &&
          typeof bounds.width === "number" &&
          typeof bounds.height === "number"
            ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
            : undefined;
        found.push({ pid, windowId: record.window_id, ...(box ? { bounds: box } : {}) });
      }
    }
    for (const child of Object.values(record)) visit(child, pid, depth + 1);
  };
  visit(value, undefined, 0);
  return complete ? found : undefined;
};
