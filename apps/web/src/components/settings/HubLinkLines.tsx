import type { HubDevice } from "@goat/client-runtime/state/hub-fleet";
import {
  hubLinkFacts,
  hubLinkWarningLabel,
  hubRelayWarningLabel,
} from "@goat/client-runtime/state/hub-link-traffic";
import type { OpenCodexHubRelayWarning } from "@goat/contracts";
/** What a Remote Link Child's link carries and how, and its relay warning; nothing when unlinked. */
export function HubDeviceLinkLines({ device }: { readonly device: HubDevice }) {
  const warning = hubLinkWarningLabel(device.traffic);
  const facts = hubLinkFacts(device, device.tunnel === "connected");
  return (
    <>
      {warning === null ? null : (
        <p role="status" className="text-xs text-warning-foreground">
          Sent {warning}. Nothing is stopped.
        </p>
      )}
      {facts.length === 0 ? null : (
        <p className="text-xs text-muted-foreground tabular-nums">{facts.join(" · ")}</p>
      )}
    </>
  );
}

/** The hub-wide relay warning line; nothing below the threshold. */
export function HubRelayWarning({
  warning,
  className,
}: {
  readonly warning: OpenCodexHubRelayWarning | null;
  readonly className?: string;
}) {
  const label = hubRelayWarningLabel(warning);
  return label === null ? null : (
    <span role="status" className={className}>
      {label}
    </span>
  );
}
