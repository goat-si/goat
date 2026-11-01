import type { HubTransport } from "@goat/client-runtime/state/hub-fleet";
import type { HubDeviceOperationResult, HubDeviceStep } from "@goat/contracts";

export type HubAction = HubDeviceOperationResult["action"];

export const HUB_ACTION_LABEL: Record<HubAction, string> = {
  join: "Join",
  leave: "Leave",
  repair: "Repair",
};

/** What each transport can do here. Join picks Hub client for Windows devices. */
export const HUB_DEVICE_ACTIONS: Record<HubTransport, ReadonlyArray<HubAction>> = {
  standalone: ["join"],
  "remote-link": ["repair", "leave"],
  "hub-client": ["repair", "leave"],
};

/** Shown while a call runs. The service reports each step when it returns, so nothing is ticked. */
export const HUB_ACTION_PLAN: Record<HubAction, string> = {
  join: "Platform check, then a Remote Link (probe, host key, link add) or, for Windows, a Hub invite and ocx connect; then parity and repair steps if checks fail.",
  leave:
    "Disconnect and restart the device, check it is standalone, then revoke its link or data key here.",
  repair: "Parity, then repair steps 1–3 as needed; re-linking asks for a decision.",
};

const STEP_LABEL: Record<HubDeviceStep["step"], string> = {
  preflight: "Platform check",
  probe: "Probe and host key",
  link_add: "Link add",
  invite: "Hub invite",
  connect: "ocx connect on device",
  sync: "Repair 1 · ocx sync",
  restart: "Repair 2 · ocx restart",
  reconnect: "Repair 3 · link reconnect",
  disconnect: "Disconnect device",
  health: "Device health",
  revoke: "Revoke on this hub",
  link_removed: "Link removed",
};

export const HUB_STATE_LABEL: Record<HubDeviceOperationResult["state"], string> = {
  child: "Linked",
  ready: "Standalone",
  degraded: "Linked with failing checks",
  needs_human: "Needs a decision",
  failed: "Failed",
};

export interface HubStepRow {
  readonly key: string;
  readonly label: string;
  readonly outcome: "ok" | "failed" | "deferred" | "waiting";
  readonly detail?: string;
}

/**
 * H3's steps in order, with the host-key comparison it makes after a probe and the parity it
 * ends on. A link add after a probe means the key matched GOAT's pin or a person approved it.
 */
export function hubStepRows(
  result: HubDeviceOperationResult,
  approvedWith: string | undefined,
): ReadonlyArray<HubStepRow> {
  const rows: HubStepRow[] = [];
  result.steps.forEach((step, index) => {
    rows.push({
      key: `${index}:${step.step}`,
      label: STEP_LABEL[step.step],
      outcome: step.outcome,
      ...(step.detail === undefined ? {} : { detail: step.detail }),
    });
    if (step.step !== "probe" || step.outcome !== "ok") return;
    const next = result.steps[index + 1]?.step;
    if (next === "link_add")
      rows.push({
        key: `${index}:key`,
        label: "Host key",
        outcome: "ok",
        detail:
          approvedWith === undefined ? "Matches GOAT's pinned key." : "Approved in a decision.",
      });
    else if (result.state === "needs_human" && result.action === "join")
      rows.push({
        key: `${index}:key`,
        label: "Host key",
        outcome: "waiting",
        detail: result.message,
      });
  });
  if (result.parity !== undefined)
    rows.push({
      key: "parity",
      label: "Parity",
      outcome: result.parity.failingCheckIds.length === 0 ? "ok" : "failed",
      detail:
        result.parity.failingCheckIds.length === 0
          ? result.parity.verdict
          : `${result.parity.verdict} (${result.parity.failingCheckIds.join(", ")})`,
    });
  return rows;
}
