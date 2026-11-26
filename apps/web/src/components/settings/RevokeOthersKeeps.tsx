import { useGT } from "gt-react";
import type { AuthRevokeOthersKeep } from "@goat/contracts";
import type { ReactElement, ReactNode } from "react";

import { InfoIcon } from "~/components/solar";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

function keptExplanation(
  gt: ReturnType<typeof useGT>,
  kept: AuthRevokeOthersKeep,
  servedByEnvironment: boolean,
): string {
  if (kept === "pen")
    return gt(
      "A Pen member holds this session, and it works only over that member's Pen connection. Revoke it here; to stop the member asking for another, remove it from Pen.",
    );
  return servedByEnvironment
    ? gt(
        "Signed in with the desktop app's built-in credential, normally the GOAT desktop app on this computer. If you do not recognise it or suspect it, revoke it by itself; if it is the desktop app's session, that signs the app out until you quit and reopen it.",
      )
    : gt(
        "Signed in with the desktop app's built-in credential, normally the GOAT desktop app on that computer. If you do not recognise it or suspect it, revoke it by itself; if it is the desktop app's session, that signs the app out until someone quits and reopens it on that computer.",
      );
}

// A popover on a real button opens on hover, on Enter or Space after a Tab, and on tap.
function Explained({
  trigger,
  label,
  children,
}: {
  readonly trigger: ReactElement;
  readonly label: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <Popover>
      <PopoverTrigger openOnHover delay={250} closeDelay={100} render={trigger}>
        {label}
      </PopoverTrigger>
      <PopoverPopup side="top" align="start" tooltipStyle width="md">
        {children}
      </PopoverPopup>
    </Popover>
  );
}

export function KeptByRevokeOthersBadge({
  kept,
  servedByEnvironment,
}: {
  readonly kept: AuthRevokeOthersKeep;
  readonly servedByEnvironment: boolean;
}) {
  const gt = useGT();
  return (
    <Explained
      trigger={<Badge variant="outline" size="sm" render={<button type="button" />} />}
      label={gt("Kept by Revoke others")}
    >
      {keptExplanation(gt, kept, servedByEnvironment)}
    </Explained>
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
  const gt = useGT();
  return (
    <>
      <Button size="xs" variant="destructive-outline" disabled={disabled} onClick={onClick}>
        {revoking ? gt("Revoking…") : gt("Revoke others")}
      </Button>
      {/* Beside the button, so the explanation stays reachable while the button is off. */}
      <Explained
        trigger={
          <Button size="icon-xs" variant="ghost" aria-label={gt("What Revoke others keeps")} />
        }
        label={<InfoIcon />}
      >
        {gt(
          "Revoke others ends every other client except sessions signed in with the desktop app's built-in credential and Pen members' sessions. Revoke those one by one below.",
        )}
      </Explained>
    </>
  );
}
