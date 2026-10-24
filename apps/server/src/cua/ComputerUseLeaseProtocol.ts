// @effect-diagnostics preferSchemaOverJson:off -- Reads only the raw MCP fields the lease proxy uses.
import type { JsonRpcId } from "./ComputerUseLeaseResponses.ts";
import type { NamedWindow } from "./x11WindowPlacement.ts";

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

export interface Envelope {
  readonly id?: JsonRpcId | null;
  readonly method?: string;
  readonly params?: {
    readonly name?: unknown;
    readonly arguments?: { readonly session?: unknown };
  };
  readonly result?: {
    readonly structuredContent?: { readonly session?: unknown };
    readonly isError?: unknown;
  };
  readonly error?: unknown;
}

export const parse = (line: string): Envelope | undefined => {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Envelope)
      : undefined;
  } catch {
    return undefined;
  }
};
