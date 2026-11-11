import type { HubDeviceStep } from "@goat/contracts";
import * as Effect from "effect/Effect";

import { deviceExit, phaseMessage } from "./hubDeviceResult.ts";
import type { HubChildConnectionAdmission, HubOcx, HubOcxError, OcxOutput } from "./HubOcx.ts";
import { decodeJson, Health, type LinkStatus } from "./hubOcxJson.ts";

const HOME_TIMEOUT_MS = 60_000;
const DEVICE_TIMEOUT_MS = 120_000;
const NOT_PROVEN = "Device did not prove it is standalone after the refused restart.";

/** The device and Home halves of removing a Remote Link membership. */
export const makeLeaveSteps = (deps: {
  readonly ocx: HubOcx["Service"];
  readonly homeLinks: () => Effect.Effect<typeof LinkStatus.Type | undefined, HubOcxError>;
}) => {
  const { ocx } = deps;
  /**
   * Device side first. The Home's own revoke runs a remote `ocx disconnect` whose failure
   * restarts the tunnel (OCX-9), so the Home is touched only after the device is standalone.
   */
  const leaveDevice = Effect.fn("HubMembership.leaveDevice")(function* (
    alias: string,
    member: string,
    admission: HubChildConnectionAdmission,
    steps: HubDeviceStep[],
  ) {
    // The device's GOAT runs both under its idle fence, bound to the membership seen here.
    let answered: OcxOutput | undefined;
    let refused: string | undefined;
    for (const kind of ["disconnect", "restart"] as const) {
      const operation = { kind, expectedLinkId: member };
      const ran = yield* ocx.connection(alias, operation, DEVICE_TIMEOUT_MS, admission).pipe(
        Effect.map((output: OcxOutput) => ({
          output,
          step:
            output.code === 0
              ? { step: kind, outcome: "ok" as const }
              : { step: kind, outcome: "failed" as const, detail: deviceExit(kind, output) },
        })),
        Effect.catch((error) =>
          Effect.succeed({
            output: undefined,
            step: { step: kind, outcome: "failed" as const, detail: error.message },
          }),
        ),
      );
      answered = ran.output;
      steps.push(ran.step);
      if (ran.step.outcome === "ok") continue;
      // Desktop- or service-owned runtimes refuse a restart; the outcome below decides. A
      // timeout (124) or no answer leaves the outcome unknown.
      if (kind === "restart" && answered !== undefined && answered.code !== 124)
        refused = ran.step.detail;
      else return ran.step.detail;
    }
    if (refused !== undefined) {
      const proven = answered?.deviceHealthy === true && answered.deviceRole === "standalone";
      steps.push({
        step: "health",
        outcome: proven ? "ok" : "failed",
        detail: proven
          ? "Device answers as standalone; the refused restart was not needed."
          : NOT_PROVEN,
      });
      return proven ? undefined : `${refused} ${NOT_PROVEN}`;
    }
    const reported = answered?.deviceRole;
    // A native Windows device has no shell for /healthz; its own GOAT already read the role.
    if (reported === "standalone") {
      steps.push({ step: "health", outcome: "ok", detail: "Device answers as standalone." });
      return undefined;
    }
    const body = yield* ocx.deviceHealth(alias);
    const health = body === undefined ? undefined : decodeJson(Health, body);
    // A standalone or Home runtime omits role; anything else still describes the link.
    const standalone =
      health?.service === "opencodex" &&
      (health.role === undefined || health.role === "standalone");
    const detail = standalone
      ? "Device answers as standalone."
      : health === undefined
        ? reported === undefined
          ? "Device /healthz did not answer after the restart."
          : `Device reports role ${reported} after the restart.`
        : `Device /healthz still reports role ${health.role}.`;
    steps.push({ step: "health", outcome: standalone ? "ok" : "failed", detail });
    return standalone ? undefined : detail;
  });

  /** Forced revoke skips the remote cleanup the device step already did; then prove it is gone. */
  const revokeOnHome = Effect.fn("HubMembership.revokeOnHome")(function* (
    alias: string,
    record: { readonly id: string; readonly tunnelPort?: number | undefined },
    steps: HubDeviceStep[],
  ) {
    const revoked = yield* ocx.home(
      ["link", "revoke", "--link-id", record.id, "--force", "--yes", "--json"],
      HOME_TIMEOUT_MS,
    );
    if (revoked.code !== 0 && revoked.phase !== "link_not_found") {
      steps.push({ step: "revoke", outcome: "failed", detail: phaseMessage(revoked) });
      return false;
    }
    steps.push({ step: "revoke", outcome: "ok", detail: record.id });
    const status = yield* deps.homeLinks();
    const recorded =
      status === undefined ||
      status.links.some((entry) => entry.id === record.id || entry.alias === alias);
    const tunnels = yield* ocx.homeTunnels(alias, record.tunnelPort);
    const gone = !recorded && tunnels === 0;
    steps.push({
      step: "link_removed",
      outcome: gone ? "ok" : "failed",
      detail: gone
        ? "No link record or ssh -R tunnel remains."
        : recorded
          ? "ocx link status still lists the link, or could not be read."
          : tunnels === undefined
            ? "This Home's ssh tunnels could not be listed."
            : `${tunnels} ssh -R tunnel for the link is still running.`,
    });
    return gone;
  });

  return { leaveDevice, revokeOnHome };
};
