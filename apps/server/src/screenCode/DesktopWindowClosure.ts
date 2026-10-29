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

export const windowClosure = (value: unknown, pid: number, target: number): WindowClosure => {
  const reply = record(value);
  const ids = reply?.authoritative_window_ids;
  if (reply?.enumeration_complete !== true || !Array.isArray(ids) || !ids.every(windowId))
    return "unproven";
  // The listing and the id snapshot are read separately; an entry the listing cannot be read
  // from could be the window, and a listed window the ids omit is a contradiction.
  const listed = reply.windows;
  if (!Array.isArray(listed)) return "unproven";
  let shown = false;
  for (const item of listed) {
    const entry = record(item);
    if (!entry || !windowId(entry.window_id)) return "unproven";
    if (entry.pid !== undefined && !Number.isSafeInteger(entry.pid)) return "unproven";
    if (entry.window_id === target && (entry.pid ?? pid) === pid) shown = true;
  }
  if (ids.includes(target)) return "present";
  return shown ? "unproven" : "closed";
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
      : yield* deps.list().pipe(Effect.timeoutOption(remain), Effect.orElseSucceed(Option.none));
  const reply = Option.getOrUndefined(listed);
  const closure =
    reply === undefined || driverError(reply)
      ? "unproven"
      : windowClosure(driverValue(reply), deps.target.pid, deps.target.windowId);
  return {
    value: { met: closure === "closed", status, closure },
    category: closure === "closed" ? ("confirmed" as const) : ("unverifiable" as const),
    evidence: [`verify_state:${status}`, `window_closure:${closure}`],
  };
});
