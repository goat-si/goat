import type { ComputerUsePrimitiveReply, ScreenRunError } from "@goat/contracts";
import * as Effect from "effect/Effect";
import { driverValue, fail } from "./DesktopDriverReplies.ts";
import { pollDesktopWait } from "./DesktopEvidence.ts";
import { buildWaitExpectation } from "./DesktopInputPlan.ts";

type GoneResult = { met: boolean; reason?: "incomplete_read" | "still_present" };

const statusOf = (reply: ComputerUsePrimitiveReply) => {
  const value = driverValue(reply);
  return typeof value === "object" && value !== null && "status" in value
    ? value.status
    : undefined;
};

/**
 * Waits until the window no longer has a matching element. The driver's verify_state checks
 * an element exists over its own exhaustive read and answers "unsatisfied" only when that read
 * was complete and trusted, so only that answer proves the element gone; "unknown" never does.
 */
export const waitForGone = Effect.fn("DesktopWaitGone.waitForGone")(function* (deps: {
  readonly args: Record<string, unknown>;
  readonly pid: number;
  readonly windowId: number;
  readonly deadline: number;
  readonly verify: (
    args: Record<string, unknown>,
  ) => Effect.Effect<ComputerUsePrimitiveReply, ScreenRunError>;
}) {
  const { args, pid, windowId } = deps;
  const hasField =
    typeof args.role === "string" ||
    typeof args.name === "string" ||
    (typeof args.value === "string" && args.value.trim().length > 0);
  const expected =
    args.gone === true &&
    hasField &&
    args.window === undefined &&
    args.enabled === undefined &&
    args.selected === undefined
      ? buildWaitExpectation({ role: args.role, name: args.name, value: args.value }).expectation
      : undefined;
  if (expected === undefined)
    return yield* Effect.fail(fail("invalid_argument", "Use gone: true with role, name or value."));
  const result = yield* pollDesktopWait({
    read: () => deps.verify({ pid, window_id: windowId, expect: [expected], timeout_ms: 0 }),
    initial: { met: false, reason: "incomplete_read" } as GoneResult,
    sample: (reply): GoneResult => {
      const status = statusOf(reply);
      return status === "unsatisfied"
        ? { met: true }
        : status === "satisfied"
          ? { met: false, reason: "still_present" }
          : { met: false, reason: "incomplete_read" };
    },
    met: (value) => value.met,
    timeoutMs: args.timeoutMs,
    cellDeadlineMillis: deps.deadline,
  });
  return {
    value: result,
    category: result.met ? ("confirmed" as const) : ("unverifiable" as const),
    evidence: result.met ? ["verify_state: no matching element in a complete read"] : [],
  };
});
