import type { ComputerUsePrimitiveReply, ScreenRunError } from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { CELL_RESERVE_MS } from "../cua/ComputerUseCallCaps.ts";
import { driverValue, fail } from "./DesktopDriverReplies.ts";
import { pollHiddenWindow } from "./DesktopEvidence.ts";
import { buildWaitExpectation } from "./DesktopInputPlan.ts";
import { waitForGone } from "./DesktopWaitGone.ts";
import { waitForOutcome } from "./DesktopWindowClosure.ts";

/** One app wait_for: an element gone, a hidden window, or a verify_state condition. */
export const runDesktopWait = Effect.fn("DesktopWait.run")(function* (deps: {
  readonly args: Record<string, unknown>;
  readonly target: { readonly pid: number; readonly windowId: number };
  readonly deadline: number;
  readonly request: (
    tool: string,
    args: Record<string, unknown>,
  ) => Effect.Effect<ComputerUsePrimitiveReply, ScreenRunError>;
}) {
  const { args, target, deadline, request } = deps;
  const list = () => request("list_windows", { pid: target.pid });
  if (args.gone !== undefined)
    return yield* waitForGone({
      args,
      pid: target.pid,
      windowId: target.windowId,
      deadline,
      verify: (verifyArgs) => request("verify_state", verifyArgs),
    });
  if (args.window === "hidden")
    return yield* pollHiddenWindow({
      list,
      pid: target.pid,
      windowId: target.windowId,
      timeoutMs: args.timeoutMs,
      cellDeadlineMillis: deadline,
    });
  const waited = buildWaitExpectation(args);
  if (waited.error || !waited.expectation)
    return yield* Effect.fail(waited.error ?? fail("invalid_argument"));
  const now = yield* Clock.currentTimeMillis;
  const requested = typeof args.timeoutMs === "number" ? args.timeoutMs : 10_000;
  const reply = yield* request("verify_state", {
    pid: target.pid,
    window_id: target.windowId,
    expect: [waited.expectation],
    // The driver call's own cap is this wait plus 2 s, within the cell's reserve.
    timeout_ms: Math.max(0, Math.min(requested, 10_000, deadline - now - CELL_RESERVE_MS - 2_000)),
  });
  const value = driverValue(reply);
  const status =
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    typeof value.status === "string" &&
    value.status.length > 0
      ? value.status
      : "unknown";
  return yield* waitForOutcome({
    status,
    gone: args.window === "gone",
    list,
    target,
    cellDeadlineMillis: deadline,
  });
});
