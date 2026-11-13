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

/** Decimal units, as the warning thresholds are set: "1.4 GB", "5 GB", "820 MB", "0 B". */
function formatLinkBytes(bytes: number): string {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const digits = unit === 0 || value >= 10 ? 0 : 1;
  return `${value.toFixed(digits).replace(/\.0$/u, "")} ${UNITS[unit]}`;
}

const eachWay = (to: number, from: number) => `↑${formatLinkBytes(to)} ↓${formatLinkBytes(from)}`;

function measuredFor(window: OpenCodexLinkTrafficWindow, fullMs: number): string | null {
  if (window.measuredMs >= fullMs * 0.95) return null;
  const minutes = Math.max(1, Math.round(window.measuredMs / 60_000));
  return minutes < 120 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
}

/**
 * Bytes by how they went: through a Pen relay, direct, or with no confirmed route (Pen's config
 * unread, or the route changed between readings), each way over the last hour and 24 hours.
 */
function hubLinkTrafficFacts(
  traffic: OpenCodexLinkTraffic,
  route: OpenCodexLinkRoute | null,
): ReadonlyArray<string> {
  const { hour, day } = traffic;
  const unconfirmed = (window: OpenCodexLinkTrafficWindow) => ({
    to: window.toHomeBytes - window.relayToHomeBytes - window.directToHomeBytes,
    from: window.fromHomeBytes - window.relayFromHomeBytes - window.directFromHomeBytes,
  });
  const [hourUnconfirmed, dayUnconfirmed] = [unconfirmed(hour), unconfirmed(day)];
  const relay = day.relayToHomeBytes + day.relayFromHomeBytes > 0 || route?.via === "relay";
  const direct = day.directToHomeBytes + day.directFromHomeBytes > 0 || route?.via === "direct";
  const measured = measuredFor(day, 24 * 3_600_000);
  const parts = [
    relay
      ? `relay ${eachWay(hour.relayToHomeBytes, hour.relayFromHomeBytes)} last hour · ${eachWay(day.relayToHomeBytes, day.relayFromHomeBytes)} in 24 h`
      : null,
    direct
      ? `direct ${eachWay(hour.directToHomeBytes, hour.directFromHomeBytes)} last hour · ${eachWay(day.directToHomeBytes, day.directFromHomeBytes)} in 24 h`
      : null,
    dayUnconfirmed.to + dayUnconfirmed.from > 0
      ? `route not confirmed ${eachWay(hourUnconfirmed.to, hourUnconfirmed.from)} last hour · ${eachWay(dayUnconfirmed.to, dayUnconfirmed.from)} in 24 h`
      : null,
  ].filter((part) => part !== null);
  return [
    ...(parts.length === 0 ? ["nothing sent in 24 h"] : parts),
    ...(measured === null ? [] : [`measured over ${measured}`]),
  ];
}

/** "via relay pen-mac", "direct mac-ts", or the name alone when the Home could not tell. */
function hubLinkRouteLabel(route: OpenCodexLinkRoute): string {
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
    link.linkTransport === null ? "transport not measured" : TRANSPORT_LABEL[link.linkTransport],
    ...(link.traffic === null
      ? ["traffic not measured"]
      : hubLinkTrafficFacts(link.traffic, link.route)),
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

/** The Remote Link Child a Fleet machine is: its dispatcher alias, any alias that named it, or its label. */
export function hubLinkOfMachine<
  Device extends { readonly alias: string; readonly tunnel: unknown },
>(
  devices: ReadonlyArray<Device>,
  machine: {
    readonly label: string;
    readonly sshHost: { readonly alias: string } | null;
    readonly reportedAliases: ReadonlyArray<{ readonly alias: string }>;
  },
): Device | null {
  const names = new Set([
    ...(machine.sshHost === null ? [] : [machine.sshHost.alias]),
    ...machine.reportedAliases.map(({ alias }) => alias),
    machine.label,
  ]);
  return devices.find((device) => device.tunnel !== null && names.has(device.alias)) ?? null;
}
