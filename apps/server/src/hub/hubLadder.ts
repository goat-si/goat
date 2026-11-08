import type { HubDeviceOperationResult, HubParityCheckId, HubParityResult } from "@goat/contracts";

/** Ladder order and the checks each rung addresses (§1.4). */
export const LADDER: ReadonlyArray<{
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
