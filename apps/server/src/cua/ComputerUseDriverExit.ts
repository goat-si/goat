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
 * The helper's other typed refusals (main.swift refuse, McpRelay.swift mcpFail): 64 bad
 * arguments, 78 no responsibility disclaim or no service spawn, 79 no usable bundled driver.
 */
const HELPER_UNSUPPORTED_EXITS: ReadonlySet<number> = new Set([64, 78, 79]);

/**
 * A helper that refused to start fails every connection from this GOAT the same way, so the
 * agent is told a restart will not help; any other exit reads as a stop or restart.
 */
export const driverExitReason = (
  driver: LeaseProxyDriver,
): Effect.Effect<"helper_refused" | "helper_unsupported" | "helper_restarted"> =>
  (driver.exitCode ?? Effect.succeed(undefined)).pipe(
    Effect.map((code) =>
      code === HELPER_REFUSED_EXIT
        ? "helper_refused"
        : code !== undefined && HELPER_UNSUPPORTED_EXITS.has(code)
          ? "helper_unsupported"
          : "helper_restarted",
    ),
  );
