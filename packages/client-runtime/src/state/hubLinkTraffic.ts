import type {
  OpenCodexHubRelayWarning,
  OpenCodexLinkRoute,
  OpenCodexLinkTraffic,
  OpenCodexLinkTrafficWindow,
  OpenCodexLinkTransport,
} from "@goat/contracts";

type TrafficPath = "relay" | "direct" | "unconfirmed";
export interface HubLinkText {
  readonly route: (name: string, via: OpenCodexLinkRoute["via"]) => string;
  readonly traffic: (path: TrafficPath, hour: string, day: string) => string;
  readonly duration: (value: number, unit: "minute" | "hour") => string;
  readonly measured: (duration: string) => string;
  readonly averaged: (duration: string) => string;
  readonly uncounted: (count: number) => string;
  readonly deviceWarning: (threshold: string) => string;
  readonly relayWarning: (sent: string, threshold: string) => string;
  readonly noTraffic: string;
  readonly httpBodies: string;
  readonly noLinkMeasurement: string;
  readonly noRouteMeasurement: string;
  readonly noTransportMeasurement: string;
  readonly noTrafficMeasurement: string;
}
const ENGLISH_LINK_TEXT: HubLinkText = {
  route: (name, via) =>
    via === undefined ? `route ${name}` : via === "relay" ? `via relay ${name}` : `direct ${name}`,
  traffic: (path, hour, day) =>
    `${path === "unconfirmed" ? "route not confirmed" : path} ${hour} last hour · ${day} in 24 h`,
  duration: (value, unit) => `${value} ${unit === "minute" ? "min" : "h"}`,
  measured: (value) => `measured over ${value}`,
  averaged: (value) => `averaged over ${value} without readings`,
  uncounted: (count) =>
    `↑ is at least: ${count} ${count === 1 ? "request" : "requests"} had no length`,
  deviceWarning: (threshold) => `over ${threshold} through the relay in 24 h`,
  relayWarning: (sent, threshold) =>
    `Children sent ${sent} through the Pen relay in 24 h (warning at ${threshold}). Nothing is stopped.`,
  noTraffic: "nothing sent in 24 h",
  httpBodies: "HTTP bodies only: link WebSocket traffic not counted",
  noLinkMeasurement: "link traffic not measured",
  noRouteMeasurement: "route not measured",
  noTransportMeasurement: "transport not measured",
  noTrafficMeasurement: "traffic not measured",
};
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

const duration = (ms: number, text: HubLinkText) => {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return minutes < 120
    ? text.duration(minutes, "minute")
    : text.duration(Math.round(minutes / 60), "hour");
};

function measuredFor(
  window: OpenCodexLinkTrafficWindow,
  fullMs: number,
  text: HubLinkText,
): string | null {
  // Nothing measured: only averaged gaps, which say so themselves.
  return window.measuredMs >= fullMs * 0.95 || window.measuredMs === 0
    ? null
    : duration(window.measuredMs, text);
}

/**
 * Bytes by how they went: through a Pen relay, direct, or with no confirmed route (Pen's config
 * unread, or the route changed between readings), each way over the last hour and 24 hours.
 */
function hubLinkTrafficFacts(
  traffic: OpenCodexLinkTraffic,
  route: OpenCodexLinkRoute | null,
  text: HubLinkText,
): ReadonlyArray<string> {
  const { hour, day } = traffic;
  const unconfirmed = (window: OpenCodexLinkTrafficWindow) => ({
    to: window.toHomeBytes - window.relayToHomeBytes - window.directToHomeBytes,
    from: window.fromHomeBytes - window.relayFromHomeBytes - window.directFromHomeBytes,
  });
  const [hourUnconfirmed, dayUnconfirmed] = [unconfirmed(hour), unconfirmed(day)];
  const relay = day.relayToHomeBytes + day.relayFromHomeBytes > 0 || route?.via === "relay";
  const direct = day.directToHomeBytes + day.directFromHomeBytes > 0 || route?.via === "direct";
  const measured = measuredFor(day, 24 * 3_600_000, text);
  const parts = [
    relay
      ? text.traffic(
          "relay",
          eachWay(hour.relayToHomeBytes, hour.relayFromHomeBytes),
          eachWay(day.relayToHomeBytes, day.relayFromHomeBytes),
        )
      : null,
    direct
      ? text.traffic(
          "direct",
          eachWay(hour.directToHomeBytes, hour.directFromHomeBytes),
          eachWay(day.directToHomeBytes, day.directFromHomeBytes),
        )
      : null,
    dayUnconfirmed.to + dayUnconfirmed.from > 0
      ? text.traffic(
          "unconfirmed",
          eachWay(hourUnconfirmed.to, hourUnconfirmed.from),
          eachWay(dayUnconfirmed.to, dayUnconfirmed.from),
        )
      : null,
  ].filter((part) => part !== null);
  const averaged = day.averagedMs ?? 0;
  const uncounted = day.uncountedRequests ?? 0;
  return [
    ...(parts.length === 0 ? [text.noTraffic] : parts),
    ...(measured === null ? [] : [text.measured(measured)]),
    ...(averaged === 0 ? [] : [text.averaged(duration(averaged, text))]),
    ...(uncounted === 0 ? [] : [text.uncounted(uncounted)]),
    ...(traffic.httpBodiesOnly === true ? [text.httpBodies] : []),
  ];
}

const TRANSPORT_LABEL: Record<OpenCodexLinkTransport, string> = {
  http: "HTTP",
  websocket: "WebSocket",
};

/** The link facts of a connected Remote Link Child; what the Home did not report reads as not measured. */
export function hubLinkFacts(
  link: HubLinkView,
  connected: boolean,
  text: HubLinkText = ENGLISH_LINK_TEXT,
): ReadonlyArray<string> {
  if (!connected) return [];
  if (link.traffic === null && link.route === null && link.linkTransport === null)
    return [text.noLinkMeasurement];
  return [
    link.route === null ? text.noRouteMeasurement : text.route(link.route.name, link.route.via),
    link.linkTransport === null ? text.noTransportMeasurement : TRANSPORT_LABEL[link.linkTransport],
    ...(link.traffic === null
      ? [text.noTrafficMeasurement]
      : hubLinkTrafficFacts(link.traffic, link.route, text)),
  ].filter((part) => part !== null);
}

/** "over 5 GB through the relay in 24 h" for a Child past the Home's per-device threshold. */
export function hubLinkWarningLabel(
  traffic: OpenCodexLinkTraffic | null,
  text: HubLinkText = ENGLISH_LINK_TEXT,
): string | null {
  return traffic?.warning === undefined
    ? null
    : text.deviceWarning(formatLinkBytes(traffic.warning.thresholdBytes));
}

/** The hub-wide warning: every Child together passed the Home's per-hub threshold. */
export function hubRelayWarningLabel(
  warning: OpenCodexHubRelayWarning | null,
  text: HubLinkText = ENGLISH_LINK_TEXT,
): string | null {
  return warning === null
    ? null
    : text.relayWarning(
        formatLinkBytes(warning.relayBytes),
        formatLinkBytes(warning.thresholdBytes),
      );
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
