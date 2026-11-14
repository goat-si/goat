import type {
  HubDeviceOperationResult,
  HubDeviceStep,
  HubParityCheckId,
  HubParityResult,
} from "@goat/contracts";
import * as Effect from "effect/Effect";

import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { deviceExit, phaseMessage } from "./hubDeviceResult.ts";
import type { HubChildConnectionAdmission, HubOcx, HubOcxError, OcxOutput } from "./HubOcx.ts";
import type { HubParity } from "./HubParity.ts";

/** Ladder order and the checks each rung addresses (§1.4). */
const LADDER: ReadonlyArray<{
  readonly step: "sync" | "restart" | "reconnect";
  readonly checks: ReadonlyArray<HubParityCheckId>;
}> = [
  { step: "sync", checks: ["P6", "P7"] },
  { step: "restart", checks: ["P5"] },
  { step: "reconnect", checks: ["P2", "P3"] },
];

export const failing = (result: HubParityResult) => result.failingCheckIds.length > 0;

export const finalState = (result: HubParityResult): HubDeviceOperationResult["state"] =>
  !failing(result) ? "child" : result.verdict === "broken" ? "failed" : "degraded";

const unreachable = (error: HubOcxError) => ({
  outcome: "failed" as const,
  detail: error.message,
});

/** Steps 1-3 of hub.device_repair. Each executed rung re-runs the verdict; stops as soon as nothing fails. */
export const makeLadder = <E>(deps: {
  readonly ocx: HubOcx["Service"];
  readonly parity: HubParity["Service"];
  readonly audit: (
    caller: { readonly actor: string; readonly profile: string },
    action: string,
    target: string,
    outcome: string,
    decisionId: string | undefined,
  ) => Effect.Effect<void, E>;
  readonly deviceTimeoutMs: number;
  readonly homeTimeoutMs: number;
}) => {
  const { ocx, parity, audit } = deps;
  const HOME_TIMEOUT_MS = deps.homeTimeoutMs;
  const DEVICE_TIMEOUT_MS = deps.deviceTimeoutMs;
  return Effect.fn("HubMembership.ladder")(function* (
    scope: McpInvocationScope,
    caller: {
      readonly actor: string;
      readonly profile: string;
      readonly connection: HubChildConnectionAdmission;
    },
    alias: string,
    linkId: string | undefined,
    initial: HubParityResult,
    steps: HubDeviceStep[],
  ) {
    let current = initial;
    for (const rung of LADDER) {
      if (!failing(current)) break;
      if (!rung.checks.some((id) => current.failingCheckIds.includes(id))) continue;
      let ran: Pick<HubDeviceStep, "outcome" | "detail">;
      if (rung.step === "reconnect") {
        if (linkId === undefined) continue;
        ran = yield* ocx
          .home(["link", "reconnect", "--link-id", linkId, "--json"], HOME_TIMEOUT_MS)
          .pipe(
            Effect.map((output: OcxOutput) =>
              output.code === 0
                ? { outcome: "ok" as const }
                : { outcome: "failed" as const, detail: phaseMessage(output) },
            ),
            Effect.catch((error) => Effect.succeed(unreachable(error))),
          );
      } else if (rung.step === "restart" && (yield* ocx.runningTurns(alias, scope)) !== 0) {
        // ADR-0019's idle rule: never restart under a running turn, and unknown is not idle.
        ran = {
          outcome: "deferred",
          detail: "A turn is running there, or its activity is unknown.",
        };
      } else {
        // A known membership restarts through the device's own GOAT; sync stays its script.
        ran = yield* (
          rung.step === "restart" && linkId !== undefined
            ? ocx.connection(
                alias,
                { kind: "restart", expectedLinkId: linkId },
                DEVICE_TIMEOUT_MS,
                caller.connection,
              )
            : ocx.device(alias, [rung.step], DEVICE_TIMEOUT_MS)
        ).pipe(
          Effect.map((output: OcxOutput) =>
            output.code === 0
              ? { outcome: "ok" as const }
              : { outcome: "failed" as const, detail: deviceExit(rung.step, output) },
          ),
          Effect.catch((error) => Effect.succeed(unreachable(error))),
        );
      }
      steps.push({ step: rung.step, ...ran });
      yield* audit(caller, `hub.repair.${rung.step}`, alias, ran.outcome, undefined);
      if (ran.outcome !== "deferred") current = yield* parity.verify(alias, scope);
    }
    return current;
  });
};
