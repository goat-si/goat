import type {
  HandoffSummary,
  HubDeviceMcpResult,
  HubDeviceOperationResult,
  HubDeviceStep,
  HubDeviceTransport,
  HubParityResult,
} from "@goat/contracts";
import { goatCallText } from "@goat/contracts/agentSurface/callText";

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
    readonly fromLinkId?: string;
    readonly fromTunnelPort?: number;
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
        : action === "move"
          ? {
              ...base,
              state: "needs_human",
              decisionId: rest.decisionId,
              kind: "needs_human",
              handoff,
              next: { after: "approval", call: "goat_hub_device_move" },
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
/** Why OpenCodex refused: its own known sentence first, then its failure code. */
export const phaseMessage = (output?: {
  readonly phase?: string | undefined;
  readonly message?: string | undefined;
}) =>
  output?.phase === "remote_platform_unsupported"
    ? "OpenCodex could not execute Remote Link on this device. Update OpenCodex on Home and check PowerShell on a Windows Child, then retry."
    : output?.message !== undefined
      ? `OpenCodex: ${output.message}`
      : output?.phase === undefined
        ? "OpenCodex refused the command. Run it on that machine to see OpenCodex's own output."
        : `OpenCodex stopped at ${output.phase}.`;

/** A device's ocx exit, with OpenCodex's own sentence when it printed a known one. */
export const deviceExit = (
  command: string,
  output: { readonly code: number; readonly message?: string | undefined },
) =>
  `ocx ${command} exited ${output.code}${output.message === undefined ? "." : `: ${output.message}`}`;

/** A success message that names the checks parity could not prove, so it never hides them. */
export const withUnproven = (message: string, parity: HubParityResult) => {
  const ids = parity.checks.filter(({ status }) => status === "unproven").map(({ id }) => id);
  return ids.length === 0 ? message : `${message} Unproven: ${ids.join(", ")}.`;
};

/**
 * When parity does not show Codex routed through this Home, say so and what the only remedy costs:
 * repair's sync rung runs ocx sync with no fence or link binding, and a runtime restart it causes
 * can cut a turn there.
 */
export const withRoutingAdvice = (message: string, alias: string, parity: HubParityResult) => {
  const routing = parity.checks.filter(({ id }) => id === "P6" || id === "P7");
  const failed = routing.filter(({ status }) => status === "failed");
  const unproven = routing.filter(({ status }) => status === "unproven");
  const repair = goatCallText("hub.device_repair");
  const ids = (checks: typeof routing) => checks.map(({ id }) => id).join(", ");
  return [
    message,
    ...(failed.length === 0
      ? []
      : [
          `Parity (${ids(failed)}) shows ${alias} not routing through this Home. ${repair} runs ocx sync there without waiting for running work: run it when ${alias} is idle, because it can interrupt a turn running there.`,
        ]),
    ...(unproven.length === 0
      ? []
      : [
          `Parity (${ids(unproven)}) cannot yet show ${alias} routing through this Home: ${unproven.map(({ reason }) => reason).join(" ")} ${repair} changes nothing for an unproven check; the proof comes from ${alias}'s GOAT (P6: the Home settings digest its OpenCodex applied; P7: each enabled client's effective endpoint on its local OpenCodex port).`,
        ]),
  ].join(" ");
};

export const linkStatusUnreadable = (forbidden: boolean) =>
  forbidden
    ? "This machine's OpenCodex answered ocx link status with a link-management 403. OpenCodex does this in Hub mode when the public listener is not loopback (lidge-jun/opencodex#8184); on such a Hub, join devices with transport hub-client."
    : "This machine's OpenCodex link status is unavailable.";
