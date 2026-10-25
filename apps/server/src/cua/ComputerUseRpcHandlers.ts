/**
 * Client RPCs for this host's computer use: driver status, Stop for one thread, the kill switch
 * and handing the screen back after a pause. Each is one call into ComputerUseLeases.
 *
 * @module ComputerUseRpcHandlers
 */
import { type AuthSessionId, type ThreadId, WS_METHODS } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as Handoffs from "../handoffs/Handoffs.ts";
import * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";
import * as ComputerUseLeases from "./ComputerUseLeases.ts";
import * as ComputerUseStatusChanges from "./ComputerUseStatusChanges.ts";
import * as CuaDriver from "./CuaDriver.ts";

/**
 * Ends the approved admissions `which` picks. A grant only narrows access when it ends, so whoever
 * may stop agents may end it. failed counts admissions it could not end, or a failure to read them.
 */
const endGrants = Effect.fn("ComputerUse.endGrants")(function* (
  leases: ComputerUseLeases.ComputerUseLeases["Service"],
  handoffs: Handoffs.Handoffs["Service"],
  sessionId: AuthSessionId,
  which: (grant: ComputerUseLeases.ComputerUseLease) => boolean,
) {
  const ended = new Set<ThreadId>();
  let failed = 0;
  const grants = yield* leases.grants.pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Stop could not read computer use admissions", { cause }).pipe(
        Effect.andThen(Effect.sync(() => void (failed += 1))),
        Effect.as([]),
      ),
    ),
  );
  const picked = grants.filter(which);
  // Released first, so they hold no app and admit no newer control even if ending them fails.
  yield* leases.release(picked.map((grant) => grant.handoffId));
  for (const grant of picked) {
    yield* handoffs
      .respond(
        { threadId: grant.threadId, handoffId: grant.handoffId, action: "cancelled" },
        sessionId,
      )
      .pipe(
        Effect.tap(() => Effect.sync(() => ended.add(grant.threadId))),
        Effect.catchCause((cause) =>
          Effect.logWarning("Stop could not end a computer use admission", {
            handoffId: grant.handoffId,
            cause,
          }).pipe(Effect.andThen(Effect.sync(() => void (failed += 1)))),
        ),
      );
  }
  return { ended, failed };
});

/**
 * The kill switch: ends every control, then every approved admission, so no later turn picks the
 * screen up with them. failed counts admissions it could not end, or a failure to read them, so
 * callers say so instead of reporting a stop that did not happen.
 */
export const stopAllComputerUse = Effect.fn("ComputerUse.stopAll")(function* (
  leases: Option.Option<ComputerUseLeases.ComputerUseLeases["Service"]>,
  handoffs: Handoffs.Handoffs["Service"],
  sessionId: AuthSessionId,
) {
  if (Option.isNone(leases)) return { stopped: 0, failed: 0 };
  const stopped = new Set(yield* leases.value.stopAll);
  const { ended, failed } = yield* endGrants(leases.value, handoffs, sessionId, () => true);
  for (const thread of ended) stopped.add(thread);
  return { stopped: stopped.size, failed };
});

/**
 * A person's Stop for one thread: ends its control, then its approved admissions, so the apps it
 * held are free for other threads at once instead of for the rest of the grant (#1519). The
 * thread asks again to go on. A turn's interrupt stops only the control and keeps the grant.
 */
export const stopComputerUse = Effect.fn("ComputerUse.stop")(function* (
  leases: Option.Option<ComputerUseLeases.ComputerUseLeases["Service"]>,
  handoffs: Handoffs.Handoffs["Service"],
  sessionId: AuthSessionId,
  threadId: ThreadId,
) {
  if (Option.isNone(leases)) return { stopped: false, failed: 0 };
  const stopped = yield* leases.value.stop(threadId);
  const { ended, failed } = yield* endGrants(
    leases.value,
    handoffs,
    sessionId,
    (grant) => grant.threadId === threadId,
  );
  return { stopped: stopped || ended.size > 0, failed };
});

export const makeComputerUseRpcHandlers = Effect.fn("ComputerUse.rpcHandlers")(function* (
  sessionId: AuthSessionId,
) {
  const driver = yield* Effect.serviceOption(CuaDriver.CuaDriver);
  const leases = yield* Effect.serviceOption(ComputerUseLeases.ComputerUseLeases);
  const handoffs = yield* Handoffs.Handoffs;
  const receiver = yield* Effect.serviceOption(DesktopTelemetryReceiver.DesktopTelemetryReceiver);

  return {
    [WS_METHODS.computerUseStatusChanges]: (_input: {}) =>
      ComputerUseStatusChanges.statusChanges(receiver),
    [WS_METHODS.serverCheckComputerUse]: (_input: {}) =>
      Option.isNone(driver)
        ? Effect.succeed({ platform: "other", running: false } as const)
        : driver.value.status,
    [WS_METHODS.computerUseStop]: (input: { readonly threadId: ThreadId }) =>
      stopComputerUse(leases, handoffs, sessionId, input.threadId).pipe(
        Effect.map(({ stopped }) => ({ stopped })),
      ),
    [WS_METHODS.computerUseStopAll]: (_input: {}) =>
      stopAllComputerUse(leases, handoffs, sessionId).pipe(
        Effect.map(({ stopped }) => ({ stopped })),
      ),
    [WS_METHODS.computerUseApps]: (_input: {}) =>
      Option.isNone(driver)
        ? Effect.succeed({ apps: [] })
        : driver.value.appCatalog.pipe(Effect.map((apps) => ({ apps }))),
    [WS_METHODS.computerUseResume]: (_input: {}) =>
      Option.isNone(leases) ? Effect.succeed({}) : leases.value.resume.pipe(Effect.as({})),
  } as const;
});
