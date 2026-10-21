import type { EnvironmentId } from "@goat/contracts";
import { useEffect } from "react";

import { ComputerUseSetup, useComputerUseHost } from "../settings/ComputerUseSettings";
import { computerUseUnavailable } from "../settings/CuaSetupDialog.logic";
import { recordFirstRunPrompt } from "./recordFirstRunPrompt";

/**
 * Asks once per desktop profile whether agents may use this computer. Later leaves computer
 * use off; Settings → Integrations → Computer use turns it on at any time.
 */
export function ComputerUseFirstRunPrompt({
  environmentId,
  onClosed,
}: {
  environmentId: EnvironmentId;
  onClosed: () => void;
}) {
  const host = useComputerUseHost(environmentId, true);
  const alreadyOn = host.enabled;
  // Someone turned it on elsewhere first; that answers the question.
  useEffect(() => {
    if (alreadyOn) void recordFirstRunPrompt("computerUse", "answered");
  }, [alreadyOn]);
  // A computer without a usable screen has nothing to ask about.
  if (
    alreadyOn ||
    !host.canConfigure ||
    host.status === null ||
    computerUseUnavailable(host.status)
  )
    return null;
  return (
    <ComputerUseSetup
      host={host}
      hostLabel={host.status.platform === "darwin" ? "this Mac" : "this computer"}
      onClose={(outcome) => {
        void recordFirstRunPrompt("computerUse", outcome === "enabled" ? "answered" : "later");
        onClosed();
      }}
    />
  );
}
