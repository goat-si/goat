import { useGT, useLocale } from "gt-react";
import type { HubDevice } from "@goat/client-runtime/state/hub-fleet";
import {
  type HubLinkText,
  hubLinkFacts,
  hubLinkWarningLabel,
  hubRelayWarningLabel,
} from "@goat/client-runtime/state/hub-link-traffic";
import type { OpenCodexHubRelayWarning } from "@goat/contracts";
function useHubLinkText(): HubLinkText {
  const gt = useGT();
  const locale = useLocale();
  return {
    route: (name, via) =>
      via === undefined
        ? gt("route {name}", { name })
        : via === "relay"
          ? gt("via relay {name}", { name })
          : gt("direct {name}", { name }),
    traffic: (path, hour, day) => {
      const kind =
        path === "relay"
          ? gt("relay")
          : path === "direct"
            ? gt("direct")
            : gt("route not confirmed");
      return gt("{kind} {hour} last hour · {day} in 24 h", { kind, hour, day });
    },
    duration: (value, unit) =>
      new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "short" }).format(value),
    measured: (duration) => gt("measured over {duration}", { duration }),
    averaged: (duration) => gt("averaged over {duration} without readings", { duration }),
    uncounted: (count) =>
      gt(
        "↑ is at least: {count, plural, one {# request had no length} other {# requests had no length}}",
        { count },
      ),
    deviceWarning: (threshold) => gt("over {threshold} through the relay in 24 h", { threshold }),
    relayWarning: (sent, threshold) =>
      gt(
        "Children sent {sent} through the Pen relay in 24 h (warning at {threshold}). Nothing is stopped.",
        { sent, threshold },
      ),
    noTraffic: gt("nothing sent in 24 h"),
    httpBodies: gt("HTTP bodies only: link WebSocket traffic not counted"),
    noLinkMeasurement: gt("link traffic not measured"),
    noRouteMeasurement: gt("route not measured"),
    noTransportMeasurement: gt("transport not measured"),
    noTrafficMeasurement: gt("traffic not measured"),
  };
}
/** What a Remote Link Child's link carries and how, and its relay warning; nothing when unlinked. */
export function HubDeviceLinkLines({ device }: { readonly device: HubDevice }) {
  const gt = useGT();
  const text = useHubLinkText();
  const warning = hubLinkWarningLabel(device.traffic, text);
  const facts = hubLinkFacts(device, device.tunnel === "connected", text);
  return (
    <>
      {warning === null ? null : (
        <p role="status" className="text-xs text-warning-foreground">
          {gt("Sent {warning}. Nothing is stopped.", { warning })}
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
  const text = useHubLinkText();
  const label = hubRelayWarningLabel(warning, text);
  return label === null ? null : (
    <span role="status" className={className}>
      {label}
    </span>
  );
}
