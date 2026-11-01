import type {
  HostPressureLevel,
  HostStatusEntry,
  HubParityResult,
  OpenCodexInventorySnapshot,
} from "@goat/contracts";
import { homeLocalFallback, openCodexPairVerdict } from "@goat/shared/opencodexCompat";

/**
 * The goatclaw hub as Fleet and Settings → Hub show it: the OpenCodex Home among the hosts a
 * client reads, and every device that is linked to it or reachable from it. One projection, so a
 * device reads the same in both places and on mobile.
 */

export type HubTransport = "remote-link" | "hub-client" | "standalone";
export type HubLinkState = OpenCodexInventorySnapshot["link"]["links"][number]["state"];
export type HubVersionVerdict = "compatible" | "degraded" | "incompatible";

export interface HubDevice {
  readonly alias: string;
  readonly transport: HubTransport;
  /** Whether the device's own host status answered; `not-connected` when GOAT here has no connection to it. */
  readonly reachability: HostStatusEntry["reachability"] | "not-connected";
  /** The Home's tunnel for this link; null for devices that are not Remote Link Children. */
  readonly tunnel: HubLinkState | null;
  readonly parity: HubParityResult | null;
  readonly version: string | null;
  /** Null while the device's OpenCodex has not been read. */
  readonly versionVerdict: HubVersionVerdict | null;
  /** Whether OpenCodex lets this device use its own providers (OCX-11); unknown before OCX-11. */
  readonly fallback: "on" | "off" | "unknown";
  readonly pressure: HostPressureLevel | null;
}

export interface HubSnapshot {
  readonly homeName: string | null;
  readonly homeVersion: string | null;
  readonly homeHealthy: boolean;
  /** Key of the source that reported the Home, so callers can mark its row. */
  readonly homeKey: string;
  readonly devices: ReadonlyArray<HubDevice>;
}

export interface HubSource {
  readonly key: string;
  /** How the client names this machine; matched with the Home's link alias. */
  readonly label: string;
  readonly entry: HostStatusEntry | null | undefined;
}

export const HUB_TRANSPORT_LABEL: Record<HubTransport, string> = {
  "remote-link": "Remote Link Child",
  "hub-client": "Hub client",
  standalone: "Standalone",
};

const opencodexOf = (entry: HostStatusEntry | null | undefined) =>
  entry?.reachability === "ok" ? entry.metrics?.opencodex : undefined;

/** Null when no host this client reads is an OpenCodex Home. */
export function hubSnapshot(sources: ReadonlyArray<HubSource>): HubSnapshot | null {
  const home = sources.find((source) => opencodexOf(source.entry)?.link.role === "home");
  const inventory = opencodexOf(home?.entry);
  if (home === undefined || inventory === undefined) return null;
  const byAlias = new Map<string, HubSource>();
  for (const source of sources) {
    if (source === home) continue;
    for (const alias of [source.entry?.host, source.label]) {
      if (alias && !byAlias.has(alias)) byAlias.set(alias, source);
    }
  }
  const device = (alias: string, source: HubSource | undefined, tunnel: HubLinkState | null) => {
    const remote = opencodexOf(source?.entry);
    const transport: HubTransport =
      tunnel !== null
        ? "remote-link"
        : remote?.hubClient?.state === "connected"
          ? "hub-client"
          : "standalone";
    const permission = remote === undefined ? undefined : homeLocalFallback(remote);
    return {
      alias,
      transport,
      reachability: source?.entry?.reachability ?? "not-connected",
      tunnel,
      parity: source?.entry?.parity ?? null,
      version: remote?.runtime.version ?? null,
      versionVerdict:
        remote === undefined || !remote.installed || transport === "standalone"
          ? null
          : openCodexPairVerdict(inventory.runtime, remote.runtime, [
              transport === "remote-link" ? "remoteLink" : "hubClient",
            ]),
      fallback: permission === undefined ? "unknown" : permission ? "on" : "off",
      pressure: source?.entry?.pressure?.level ?? null,
    } satisfies HubDevice;
  };
  const linked = inventory.link.links.map((link) =>
    device(link.alias, byAlias.get(link.alias), link.state),
  );
  const seen = new Set<HubSource>(linked.flatMap((entry) => byAlias.get(entry.alias) ?? []));
  // Only machines that answered: a device that cannot be read cannot be joined either.
  const others = sources.flatMap((source) =>
    source === home || seen.has(source) || source.entry?.reachability !== "ok"
      ? []
      : [device(source.entry.host ?? source.label, source, null)],
  );
  return {
    homeName: inventory.link.homeName ?? null,
    homeVersion: inventory.runtime.version ?? null,
    homeHealthy: inventory.runtime.healthy,
    homeKey: home.key,
    devices: [...linked, ...others],
  };
}

/** "degraded (P5, P6)", "not verified", or "unproven". */
export function hubParityLabel(parity: HubParityResult | null): string {
  if (parity === null) return "not verified";
  return parity.failingCheckIds.length === 0
    ? parity.verdict
    : `${parity.verdict} (${parity.failingCheckIds.join(", ")})`;
}

export function hubVersionLabel(device: HubDevice): string {
  if (device.version === null) return "OpenCodex not read";
  return device.versionVerdict === null
    ? `OpenCodex ${device.version}`
    : `OpenCodex ${device.version}, ${device.versionVerdict}`;
}

const REACHABILITY_LABEL: Record<HubDevice["reachability"], string | null> = {
  ok: null,
  unreachable: "not answering",
  unsupported: "update GOAT there",
  "not-connected": "no GOAT connection",
};

/** Null while the device answers. */
export const hubReachabilityLabel = (device: HubDevice) => REACHABILITY_LABEL[device.reachability];

/** What a device's row says after its alias and transport. */
export function hubDeviceFacts(device: HubDevice): ReadonlyArray<string> {
  return [
    hubReachabilityLabel(device),
    `parity ${hubParityLabel(device.parity)}`,
    device.tunnel === null ? null : `tunnel ${device.tunnel}`,
    hubVersionLabel(device),
    `OpenCodex fallback ${device.fallback}`,
    device.pressure === null ? null : `pressure ${device.pressure}`,
  ].filter((part) => part !== null);
}

/** Broken, incompatible or a failed tunnel first, then degraded or a tunnel coming up. */
export function hubDeviceSeverity(device: HubDevice): "destructive" | "warning" | null {
  if (
    device.parity?.verdict === "broken" ||
    device.versionVerdict === "incompatible" ||
    device.tunnel === "failed"
  )
    return "destructive";
  if (
    device.parity?.verdict === "degraded" ||
    (device.tunnel !== null && device.tunnel !== "connected")
  )
    return "warning";
  return null;
}
