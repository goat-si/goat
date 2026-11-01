import { OrchestratorMcpFailure, type RuntimeMode } from "@goat/contracts";
import * as Effect from "effect/Effect";

import { assertLiveCaller, readCaller } from "./threadAccess.ts";

const modes: Readonly<Record<RuntimeMode, number>> = {
  "approval-required": 0,
  "auto-accept-edits": 1,
  auto: 2,
  "full-access": 3,
};

/**
 * Dispatch reruns this effect at each authorization milestone. A feature's live grant can
 * narrow the caller, but cannot bypass live-run or default-mode checks or raise its ceiling.
 */
export const authorize = Effect.fn("HostToolAuthorization.authorize")(function* (
  writes: boolean,
  narrowing?: Effect.Effect<RuntimeMode, OrchestratorMcpFailure>,
) {
  const caller = yield* readCaller();
  yield* assertLiveCaller(caller);
  // Outside sessions carry only runtime ceilings and execute in default interaction mode.
  if (writes && caller.limits.interactionMode !== "default")
    return yield* new OrchestratorMcpFailure({
      code: "interaction_mode_escalation_denied",
      message: `Changing a thread on another machine needs a caller in default interaction mode; this caller is in ${caller.limits.interactionMode} mode.`,
    });
  const current = caller.limits.runtimeMode;
  if (narrowing === undefined) return current;
  const additional = yield* narrowing;
  return modes[current] <= modes[additional] ? current : additional;
});
