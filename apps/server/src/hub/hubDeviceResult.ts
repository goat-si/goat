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
