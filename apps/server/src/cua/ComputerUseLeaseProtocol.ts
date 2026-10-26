// @effect-diagnostics preferSchemaOverJson:off -- Reads only the raw MCP fields the lease proxy uses.
import { ComputerUseLeaseUpdate } from "@goat/contracts";
import type { JsonRpcId } from "./ComputerUseLeaseResponses.ts";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Option from "effect/Option";
import * as Scheduler from "effect/Scheduler";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { callResource } from "./ComputerUseCallReservations.ts";
import type { ListedApp } from "./ComputerUseScope.ts";
import type { NamedWindow, WindowPlacement } from "./x11WindowPlacement.ts";

const MAX_NAMED_NODES = 4_096;

/** The pid a window call acts on; desktop calls and reads act on no single app. */
const windowPid = (name: unknown, args: unknown) => {
  const resource = callResource({ name: typeof name === "string" ? name : "", args });
  return typeof resource === "object" ? resource.pid : undefined;
};

/** The app a window call acts on, by the id its scope check uses, for its app lease (D17). */
export const callApp = (name: unknown, args: unknown, listed: ReadonlyMap<number, ListedApp>) => {
  const pid = windowPid(name, args);
  return pid === undefined ? undefined : listed.get(pid)?.id;
};

/** Ids of the lease proxy's own requests to the driver; their answers never reach the provider. */
export const OWN_ID = "goat-proxy:";

/**
 * Tools that act on no app: they run before the driver has shown it is on GOAT's screen. Every
 * other tool waits for that proof (#1358).
 */
export const DISPLAY_PROOF_FREE: ReadonlySet<string> = new Set([
  "check_permissions",
  "get_guide",
  "list_apps",
  "list_windows",
  "get_screen_size",
  "get_cursor_position",
  "start_session",
  "get_session",
  "list_sessions",
  "get_agent_cursor_state",
]);

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

/**
 * Where a reply's windows are. "proof" is a reply that shows the driver is on GOAT's screen:
 * windows it names are all there, or an unfiltered list_windows saw none (a filtered one that
 * finds nothing says nothing about the screen).
 */
export const replyPlacement = Effect.fnUntraced(function* (
  placement: ((windows: ReadonlyArray<NamedWindow>) => Effect.Effect<WindowPlacement>) | undefined,
  message: Envelope,
  tool: string | undefined,
  unfiltered: boolean,
) {
  if (placement === undefined || message.result?.isError === true) return "same" as const;
  const content = message.result?.structuredContent;
  const windows = namedWindows(content);
  if (windows === undefined) return "unknown" as const;
  const where = yield* placement(windows);
  if (where !== "same") return where;
  const listed =
    tool === "list_windows" &&
    unfiltered &&
    Array.isArray((content as { windows?: unknown })?.windows);
  return windows.length > 0 || listed ? ("proof" as const) : ("same" as const);
});

/**
 * Runs a call's registration and write unless its child is no longer current ("stale") or it
 * takes the screen while another thread shares it ("shared"), or its permission expired; the caller
 * answers as not run. The checks and the write run with no scheduler yield between them (#1496), so neither a
 * pause, a narrowed approval nor the update that shares the screen can land in between.
 */
// Already traced by the proxy's call handler; this is its final per-call scheduling barrier.
export const sendUnlessShared = Effect.fnUntraced(
  function* (
    takesScreen: boolean,
    shared: () => boolean,
    current: () => boolean,
    send: Effect.Effect<void>,
    permissionDeadline = Infinity,
  ) {
    if (!current()) return "stale" as const;
    if (takesScreen && shared()) return "shared" as const;
    if ((yield* Clock.currentTimeMillis) >= permissionDeadline) return "expired" as const;
    yield* send;
    return "sent" as const;
  },
  Effect.provideService(Scheduler.PreventSchedulerYield, true),
);

const decodeUpdate = Schema.decodeUnknownOption(ComputerUseLeaseUpdate);

/** Parses one NDJSON chunk stream from the lease route into updates, dropping unknown lines. */
export const leaseUpdateLines = <E>(lines: Stream.Stream<string, E>) =>
  lines.pipe(
    Stream.filter((line) => line.trim().length > 0),
    Stream.map((line) => {
      const parsed = parse(line);
      return parsed === undefined ? Option.none() : decodeUpdate(parsed);
    }),
    Stream.filter(Option.isSome),
    Stream.map((update) => update.value),
  );
