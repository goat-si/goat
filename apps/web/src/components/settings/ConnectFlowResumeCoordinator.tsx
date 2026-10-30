import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import {
  connectFlowResumeHash,
  peekConnectFlowResume,
  finishConnectFlowResume,
} from "./connectFlowResume";

/** After a Network access or Tailscale HTTPS relaunch, returns to the Connections flow it left. */
export function ConnectFlowResumeCoordinator() {
  const navigate = useNavigate();
  // oxlint-disable-next-line goat/react-effect-budget -- navigates once after the relaunched app mounts
  useEffect(() => {
    const flow = peekConnectFlowResume();
    if (flow === null) return;
    // The phone QR and pairing link dialogs consume their own note when they reopen.
    if (flow === "connections") finishConnectFlowResume(flow);
    void navigate({
      to: "/settings/connections",
      hash: connectFlowResumeHash(flow),
      replace: true,
    });
  }, [navigate]);
  return null;
}
