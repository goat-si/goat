/**
 * Whether a pid-scoped list_windows reply proves a window closed. Closed means the window was no
 * longer one of that pid's WindowServer windows at snapshot time (also when the process exited);
 * it says nothing about why, and a reused pid or a later reopen is the caller's to rule out.
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { ComputerUsePrimitiveReply, ScreenRunError } from "@goat/contracts";
import { CELL_RESERVE_MS, MIN_CALL_MS } from "../cua/ComputerUseCallCaps.ts";
import { driverError, driverValue } from "./DesktopDriverReplies.ts";

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const windowId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

export type WindowClosure = "closed" | "present" | "unproven";

/**
 * Every window id WindowServer gave a pid at snapshot time, when the reply is a complete
 * enumeration whose listing agrees with its ids; otherwise nothing, since a missing id proves nothing.
 */
export const authoritativeIds = (value: unknown, pid: number): ReadonlySet<number> | undefined => {
  const reply = record(value);
  const ids = reply?.authoritative_window_ids;
  if (reply?.enumeration_complete !== true || !Array.isArray(ids) || !ids.every(windowId))
    return undefined;
  // The listing and the id snapshot are read separately; an entry the listing cannot be read
  // from could be the window, and a listed window the ids omit is a contradiction.
  const listed = reply.windows;
  if (!Array.isArray(listed)) return undefined;
  for (const item of listed) {
    const entry = record(item);
    if (!entry || !windowId(entry.window_id)) return undefined;
    if (entry.pid !== undefined && !Number.isSafeInteger(entry.pid)) return undefined;
    if ((entry.pid ?? pid) === pid && !ids.includes(entry.window_id)) return undefined;
  }
  return new Set(ids);
};

export const windowClosure = (value: unknown, pid: number, target: number): WindowClosure => {
  const ids = authoritativeIds(value, pid);
  return ids === undefined ? "unproven" : ids.has(target) ? "present" : "closed";
};

/**
 * Windows that entered a pid's complete id snapshot between two listings. A menu or other
 * non-zero layer a click can show, as the listing names it, is not a window it opened.
 */
export const openedWindowIds = (before: unknown, after: unknown, pid: number): number[] => {
  const pre = authoritativeIds(before, pid);
  const post = authoritativeIds(after, pid);
  const listed = record(after)?.windows;
  if (pre === undefined || post === undefined || !Array.isArray(listed)) return [];
  const layered = new Set(
    listed
      .map(record)
      .filter((entry) => entry !== undefined && (entry.pid ?? pid) === pid)
      .filter((entry) => entry?.layer !== undefined && entry.layer !== 0)
      .map((entry) => entry?.window_id),
  );
  return [...post].filter((id) => !pre.has(id) && !layered.has(id));
};

/**
 * A desktop waitFor's answer. For {window:"gone"} the driver's verify_state counts a window missing
 * from a listing that may be incomplete as gone, so met needs a closure its own listing proves.
 */
export const waitForOutcome = Effect.fn("DesktopWindowClosure.waitForOutcome")(function* (deps: {
  readonly status: string;
  readonly gone: boolean;
  readonly list: () => Effect.Effect<ComputerUsePrimitiveReply, ScreenRunError>;
  readonly target: { readonly pid: number; readonly windowId: number };
  readonly cellDeadlineMillis: number;
}) {
  const { status } = deps;
  if (!deps.gone || status !== "satisfied")
    return {
      value: { met: status === "satisfied", status },
      category: status === "satisfied" ? ("confirmed" as const) : ("unverifiable" as const),
      evidence: [`verify_state:${status}`],
    };
  const remain = deps.cellDeadlineMillis - (yield* Clock.currentTimeMillis) - CELL_RESERVE_MS;
  const listed =
    remain < MIN_CALL_MS
      ? Option.none()
      : yield* deps.list().pipe(
          Effect.timeoutOption(remain),
          Effect.catchIf(
            (error) => error.code !== "stopped_by_person" && error.code !== "screen_locked",
            () => Effect.succeedNone,
          ),
        );
  const reply = Option.getOrUndefined(listed);
  const error = reply === undefined ? undefined : driverError(reply);
  if (error?.code === "stopped_by_person" || error?.code === "screen_locked")
    return yield* Effect.fail(error);
  const closure =
    reply === undefined || error
      ? "unproven"
      : windowClosure(driverValue(reply), deps.target.pid, deps.target.windowId);
  return {
    value: { met: closure === "closed", status, closure },
    category: closure === "closed" ? ("confirmed" as const) : ("unverifiable" as const),
    evidence: [`verify_state:${status}`, `window_closure:${closure}`],
  };
});
