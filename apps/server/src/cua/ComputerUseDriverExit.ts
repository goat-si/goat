/**
 * Why a lease proxy's driver child ended on its own, read from its exit code.
 *
 * @module ComputerUseDriverExit
 */
import * as Effect from "effect/Effect";

import type { LeaseProxyDriver } from "./ComputerUseLeaseProxyOptions.ts";

/** The macOS and Windows helpers exit 77 when their parent check refuses the launching process. */
const HELPER_REFUSED_EXIT = 77;

/**
 * A helper that refused its launcher fails every connection from this GOAT the same way, so the
 * agent is told a restart will not help; any other exit reads as a stop or restart.
 */
export const driverExitReason = (
  driver: LeaseProxyDriver,
): Effect.Effect<"helper_refused" | "helper_restarted"> =>
  (driver.exitCode ?? Effect.succeed(undefined)).pipe(
    Effect.map((code) => (code === HELPER_REFUSED_EXIT ? "helper_refused" : "helper_restarted")),
  );
