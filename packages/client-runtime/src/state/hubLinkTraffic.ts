import type {
  OpenCodexHubRelayWarning,
  OpenCodexLinkRoute,
  OpenCodexLinkTraffic,
  OpenCodexLinkTrafficWindow,
  OpenCodexLinkTransport,
} from "@goat/contracts";

/** What a Remote Link Child's link carried and how, as the Home measured it. */
export interface HubLinkView {
  readonly traffic: OpenCodexLinkTraffic | null;
  readonly route: OpenCodexLinkRoute | null;
  readonly linkTransport: OpenCodexLinkTransport | null;
}

const UNITS = ["B", "kB", "MB", "GB", "TB"] as const;

/** Decimal units, as the warning thresholds are set: "1.4 GB", "820 MB", "0 B". */
export function formatLinkBytes(bytes: number): string {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const digits = unit === 0 || value >= 10 ? 0 : 1;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

const eachWay = (to: number, from: number) => `↑${formatLinkBytes(to)} ↓${formatLinkBytes(from)}`;

function measuredFor(window: OpenCodexLinkTrafficWindow, fullMs: number): string | null {
  if (window.measuredMs >= fullMs * 0.95) return null;
  const minutes = Math.max(1, Math.round(window.measuredMs / 60_000));
  return minutes < 120 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
}

/**
 * "relay ↑1.2 GB ↓120 MB last hour · ↑14 GB ↓1.4 GB in 24 h", plus the bytes that went
 * direct when there were any, and how long a short measurement covered.
 */
export function hubLinkTrafficFacts(traffic: OpenCodexLinkTraffic): ReadonlyArray<string> {
  const { hour, day } = traffic;
  const directDayTo = day.toHomeBytes - day.relayToHomeBytes;
  const directDayFrom = day.fromHomeBytes - day.relayFromHomeBytes;
  const measured = measuredFor(day, 24 * 3_600_000);
  return [
    `relay ${eachWay(hour.relayToHomeBytes, hour.relayFromHomeBytes)} last hour · ${eachWay(day.relayToHomeBytes, day.relayFromHomeBytes)} in 24 h`,
    directDayTo + directDayFrom > 0
      ? `not via relay ${eachWay(directDayTo, directDayFrom)} in 24 h`
      : null,
    measured === null ? null : `measured over ${measured}`,
  ].filter((part) => part !== null);
}

/** "via relay pen-mac", "direct mac-ts", or the name alone when the Home could not tell. */
export function hubLinkRouteLabel(route: OpenCodexLinkRoute): string {
  return route.via === undefined
    ? `route ${route.name}`
    : route.via === "relay"
      ? `via relay ${route.name}`
      : `direct ${route.name}`;
}

const TRANSPORT_LABEL: Record<OpenCodexLinkTransport, string> = {
  http: "HTTP",
  websocket: "WebSocket",
};

/** The link facts of a connected Remote Link Child; what the Home did not report reads as not measured. */
export function hubLinkFacts(link: HubLinkView, connected: boolean): ReadonlyArray<string> {
  if (!connected) return [];
  if (link.traffic === null && link.route === null && link.linkTransport === null)
    return ["link traffic not measured"];
  return [
    link.route === null ? "route not measured" : hubLinkRouteLabel(link.route),
    link.linkTransport === null ? null : TRANSPORT_LABEL[link.linkTransport],
    ...(link.traffic === null ? ["traffic not measured"] : hubLinkTrafficFacts(link.traffic)),
  ].filter((part) => part !== null);
}

/** "over 5 GB through the relay in 24 h" for a Child past the Home's per-device threshold. */
export function hubLinkWarningLabel(traffic: OpenCodexLinkTraffic | null): string | null {
  return traffic?.warning === undefined
    ? null
    : `over ${formatLinkBytes(traffic.warning.thresholdBytes)} through the relay in 24 h`;
}

/** The hub-wide warning: every Child together passed the Home's per-hub threshold. */
export function hubRelayWarningLabel(warning: OpenCodexHubRelayWarning | null): string | null {
  return warning === null
    ? null
    : `Children sent ${formatLinkBytes(warning.relayBytes)} through the Pen relay in 24 h (warning at ${formatLinkBytes(warning.thresholdBytes)}). Nothing is stopped.`;
}
