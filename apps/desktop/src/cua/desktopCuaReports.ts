import type { CuaAgentBlock } from "@goat/contracts";
import { COMPUTER_USE_HELPER_NAME } from "@goat/shared/cuaDriverRelease";
import * as Effect from "effect/Effect";

import type * as DesktopTelemetryPublisher from "../telemetry/DesktopTelemetryPublisher.ts";
import type { CuaGrantRead } from "./DesktopCuaGrants.ts";

/** The desktop's answers to a driver request it does not serve, sent only while it is open. */
export function cuaDriverReports(
  publisher: DesktopTelemetryPublisher.DesktopTelemetryPublisher["Service"],
  isClosed: () => boolean,
) {
  const report = (
    requestId: string,
    status: "stopped" | "unavailable",
    message?: string,
    block?: CuaAgentBlock,
  ) =>
    isClosed()
      ? Effect.void
      : publisher.publishCuaReport({
          version: 1,
          type: "cuaDriverReport",
          requestId,
          status,
          ...(message === undefined ? {} : { message }),
          ...(block === undefined ? {} : { block }),
        });
  return {
    report,
    unavailable: (requestId: string) =>
      report(
        requestId,
        "unavailable",
        "Computer use is unavailable. Try again after the driver has stopped.",
      ),
    /**
     * Agents get no driver while macOS lacks a grant for the app that holds them. The typed
     * reason beside the sentence is what the tile, Settings and the agent name (#1399).
     */
    ungranted: (requestId: string, grants: CuaGrantRead, holder: "helper" | "app") =>
      report(
        requestId,
        "unavailable",
        holder === "helper"
          ? `Allow Accessibility and Screen Recording for ${COMPUTER_USE_HELPER_NAME} in System Settings, then restart computer use.`
          : "Allow Accessibility and Screen Recording in System Settings, then restart computer use.",
        {
          reason: "permissionsNotGranted",
          missing: (["accessibility", "screenRecording"] as const).filter(
            (grant) => !grants[grant],
          ),
          holder,
        },
      ),
  };
}
