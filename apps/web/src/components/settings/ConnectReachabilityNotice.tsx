import type { AdvertisedEndpoint, DesktopServerExposureState } from "@goat/contracts";
import type { ReactNode } from "react";

import { Button } from "../ui/button";
import { type ConnectFlow, requestConnectFlowResume } from "./connectFlowResume";

export type ConnectReachabilityStep =
  | "network-access"
  | "tailscale-https"
  | "tailscale-unreachable";
type ExposureState = Pick<DesktopServerExposureState, "mode" | "tailscaleServeEnabled">;

/**
 * Which switch stands between this desktop and another device. With network access off the
 * desktop does not probe Tailscale, so only Tailscale HTTPS that is already on counts as reachable.
 */
export function connectReachabilityStep(
  state: ExposureState | null,
  tailscaleHttpsEndpoint: AdvertisedEndpoint | null,
): ConnectReachabilityStep | null {
  if (state === null || tailscaleHttpsEndpoint?.status === "available") return null;
  // Serve already on but unreachable: enabling it again would not restart or fix anything.
  if (state.tailscaleServeEnabled) return "tailscale-unreachable";
  if (state.mode === "local-only") return "network-access";
  return tailscaleHttpsEndpoint ? "tailscale-https" : null;
}

export type ConnectReachabilityActions = {
  readonly onTurnOnNetworkAccess: () => void;
  readonly onTurnOnTailscaleHttps: (endpoint: AdvertisedEndpoint) => void;
};

/** Offers the missing switch where the user is connecting; the confirm it opens restarts GOAT. */
export function ConnectReachabilityNotice({
  flow,
  state,
  tailscaleHttpsEndpoint,
  disabled,
  onBeforeAction,
  actions,
}: {
  readonly flow: ConnectFlow;
  readonly state: ExposureState | null;
  readonly tailscaleHttpsEndpoint: AdvertisedEndpoint | null;
  readonly disabled?: boolean;
  /** Closes the dialog hosting the notice so the restart confirm is the only one open. */
  readonly onBeforeAction?: () => void;
  readonly actions: ConnectReachabilityActions;
}): ReactNode {
  const step = connectReachabilityStep(state, tailscaleHttpsEndpoint);
  if (step === null) return null;
  if (step === "tailscale-unreachable") {
    return (
      <p className="text-sm text-muted-foreground" role="status">
        Tailscale HTTPS is on, but Tailscale is not answering. Check that Tailscale is running and
        signed in on this computer.
      </p>
    );
  }
  const start = () => {
    onBeforeAction?.();
    requestConnectFlowResume(flow);
    if (step === "network-access") actions.onTurnOnNetworkAccess();
    else if (tailscaleHttpsEndpoint) actions.onTurnOnTailscaleHttps(tailscaleHttpsEndpoint);
  };
  return (
    <div className="space-y-2" role="group" aria-label="Make this computer reachable">
      <p className="text-sm text-muted-foreground">
        {step === "network-access"
          ? "Other devices cannot reach this computer yet. Turn on Network access so they can connect over your local network or Tailscale."
          : "Tailscale HTTPS is off. Turn it on for a secure address your devices can use anywhere on your tailnet."}
      </p>
      <p className="text-xs text-muted-foreground">
        GOAT restarts to apply this, then brings you back here.
      </p>
      <Button size="sm" disabled={disabled} onClick={start}>
        {step === "network-access" ? "Turn on Network access" : "Turn on Tailscale HTTPS"}
      </Button>
    </div>
  );
}
