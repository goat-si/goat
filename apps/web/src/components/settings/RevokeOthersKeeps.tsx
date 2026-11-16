import type { AuthRevokeOthersKeep } from "@goat/contracts";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

function keptTooltip(kept: AuthRevokeOthersKeep, servedByEnvironment: boolean): string {
  if (kept === "pen")
    return "A Pen member holds this session, and it works only over that member's Pen connection. Revoke it here; to stop the member asking for another, remove it from Pen.";
  return servedByEnvironment
    ? "The GOAT desktop app on this computer signs in with this session. Revoking it signs that app out until you quit and reopen it."
    : "The GOAT desktop app on that computer signs in with this session. Revoking it signs that app out until someone quits and reopens it on that computer.";
}

export function KeptByRevokeOthersBadge({
  kept,
  servedByEnvironment,
}: {
  readonly kept: AuthRevokeOthersKeep;
  readonly servedByEnvironment: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Badge variant="outline" size="sm" />}>
        Kept by Revoke others
      </TooltipTrigger>
      <TooltipPopup>{keptTooltip(kept, servedByEnvironment)}</TooltipPopup>
    </Tooltip>
  );
}

export function RevokeOthersButton({
  disabled,
  revoking,
  onClick,
}: {
  readonly disabled: boolean;
  readonly revoking: boolean;
  readonly onClick: () => void;
}) {
  return (
    <Tooltip>
      {/* A disabled button takes no pointer events, so the span keeps the tooltip reachable. */}
      <TooltipTrigger render={<span className="inline-flex" />}>
        <Button size="xs" variant="destructive-outline" disabled={disabled} onClick={onClick}>
          {revoking ? "Revoking…" : "Revoke others"}
        </Button>
      </TooltipTrigger>
      <TooltipPopup>
        Revokes every other client except the desktop app's own session and Pen members' sessions.
      </TooltipPopup>
    </Tooltip>
  );
}
