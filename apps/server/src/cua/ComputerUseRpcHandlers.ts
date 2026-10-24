/**
 * Client RPCs for this host's computer use: driver status, Stop for one thread, the kill switch
 * and handing the screen back after a pause. Each is one call into ComputerUseLeases.
 *
 * @module ComputerUseRpcHandlers
 */
import { type AuthSessionId, WS_METHODS } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as Handoffs from "../handoffs/Handoffs.ts";
import * as ComputerUseLeases from "./ComputerUseLeases.ts";
import * as CuaDriver from "./CuaDriver.ts";

/** The kill switch: ends every control, then every approved admission, so no later turn picks the screen up. */
export const stopAllComputerUse = Effect.fn("ComputerUse.stopAll")(function* (
  leases: Option.Option<ComputerUseLeases.ComputerUseLeases["Service"]>,
  handoffs: Handoffs.Handoffs["Service"],
  sessionId: AuthSessionId,
) {
  if (Option.isNone(leases)) return { stopped: 0 };
  const stopped = new Set(yield* leases.value.stopAll);
  const grants = yield* leases.value.grants.pipe(Effect.orElseSucceed(() => []));
  for (const grant of grants) {
    yield* handoffs
      .respond(
        { threadId: grant.threadId, handoffId: grant.handoffId, action: "cancelled" },
        sessionId,
      )
      .pipe(
        Effect.tap(() => Effect.sync(() => stopped.add(grant.threadId))),
        Effect.catchCause((cause) =>
          Effect.logWarning("Kill switch could not end a computer use admission", {
            handoffId: grant.handoffId,
            cause,
          }),
        ),
      );
  }
  return { stopped: stopped.size };
});

export const makeComputerUseRpcHandlers = Effect.fn("ComputerUse.rpcHandlers")(function* (
  sessionId: AuthSessionId,
) {
  const driver = yield* Effect.serviceOption(CuaDriver.CuaDriver);
  const leases = yield* Effect.serviceOption(ComputerUseLeases.ComputerUseLeases);
  const handoffs = yield* Handoffs.Handoffs;

  return {
    [WS_METHODS.serverCheckComputerUse]: (_input: {}) =>
      Option.isNone(driver)
        ? Effect.succeed({ platform: "other", running: false } as const)
        : driver.value.status,
    [WS_METHODS.computerUseStop]: (input: {
      readonly threadId: import("@goat/contracts").ThreadId;
    }) =>
      Option.isNone(leases)
        ? Effect.succeed({ stopped: false })
        : leases.value.stop(input.threadId).pipe(Effect.map((stopped) => ({ stopped }))),
    [WS_METHODS.computerUseStopAll]: (_input: {}) =>
      stopAllComputerUse(leases, handoffs, sessionId),
    [WS_METHODS.computerUseResume]: (_input: {}) =>
      Option.isNone(leases) ? Effect.succeed({}) : leases.value.resume.pipe(Effect.as({})),
  } as const;
});
