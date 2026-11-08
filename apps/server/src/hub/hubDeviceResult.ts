import type {
  HandoffSummary,
  HubDeviceMcpResult,
  HubDeviceOperationResult,
  HubDeviceStep,
  HubDeviceTransport,
  HubParityResult,
} from "@goat/contracts";

/**
 * A hub device tool's answer. A thread's approval is a handoff, so the same tool continues once a
 * person answers it.
 */
export const hubDeviceResult = (
  action: HubDeviceOperationResult["action"],
  alias: string,
  state: HubDeviceOperationResult["state"],
  message: string,
  steps: ReadonlyArray<HubDeviceStep>,
  extra: {
    readonly parity?: HubParityResult;
    readonly decisionId?: string;
    readonly handoff?: HandoffSummary;
    readonly transport?: HubDeviceTransport;
  } = {},
): HubDeviceMcpResult => {
  const { handoff, ...rest } = extra;
  const base = { deviceAlias: alias, action, state, message, steps, ...rest };
  return handoff === undefined || rest.decisionId === undefined
    ? base
    : action === "join"
      ? {
          ...base,
          state: "needs_human",
          decisionId: rest.decisionId,
          kind: "needs_human",
          handoff,
          next: { after: "approval", call: "goat_hub_device_join" },
        }
      : action === "leave"
        ? {
            ...base,
            state: "needs_human",
            decisionId: rest.decisionId,
            kind: "needs_human",
            handoff,
            next: { after: "approval", call: "goat_hub_device_leave" },
          }
        : {
            ...base,
            state: "needs_human",
            decisionId: rest.decisionId,
            kind: "needs_human",
            handoff,
            next: { after: "approval", call: "goat_hub_device_repair" },
          };
};
export const phaseMessage = (phase: string | undefined) =>
  phase === "remote_platform_unsupported"
    ? "OpenCodex could not execute Remote Link on this device. Update OpenCodex on Home and check PowerShell on a Windows Child, then retry."
    : phase === undefined
      ? "OpenCodex refused the command."
      : `OpenCodex stopped at ${phase}.`;

/** OpenCodex answers `ocx link status` with 403 on a Hub whose public listener is not loopback. */
export const linkStatusUnreadable = (forbidden: boolean) =>
  forbidden
    ? "This machine's OpenCodex refused ocx link status with 403, which it does in Hub mode when its public listener is not loopback (lidge-jun/opencodex#8184). Join devices to this Hub with transport hub-client, or bind its public listener to loopback."
    : "This machine's OpenCodex link status is unavailable.";
