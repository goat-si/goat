import type { AdvertisedEndpoint, DesktopServerExposureState } from "@goat/contracts";
import type { ReactNode } from "react";

import { finishConnectFlowResume, peekConnectFlowResume } from "./connectFlowResume";
import {
  type ConnectReachabilityActions,
  ConnectReachabilityNotice,
} from "./ConnectReachabilityNotice";

/** What the Create pairing link dialog needs to offer the missing switch and reopen after it. */
export type ConnectFlowSlot = {
  /** True on the first render after a relaunch this dialog asked for. */
  readonly resume: boolean;
  readonly notice: (closeDialog: () => void) => ReactNode;
  readonly onDone: () => void;
};

export const pairingLinkConnectFlow = {
  finish: () => finishConnectFlowResume("pairing-link"),
  slot: (input: {
    readonly state: DesktopServerExposureState | null;
    readonly tailscaleHttpsEndpoint: AdvertisedEndpoint | null;
    readonly disabled: boolean;
    readonly actions: ConnectReachabilityActions;
  }): ConnectFlowSlot => ({
    resume: peekConnectFlowResume() === "pairing-link",
    notice: (closeDialog) => (
      <ConnectReachabilityNotice
        flow="pairing-link"
        state={input.state}
        tailscaleHttpsEndpoint={input.tailscaleHttpsEndpoint}
        disabled={input.disabled}
        onBeforeAction={closeDialog}
        actions={input.actions}
      />
    ),
    onDone: () => finishConnectFlowResume("pairing-link"),
  }),
};
