import type { OpenCodexInventorySnapshot, OpenCodexProtocolEvidence } from "@goat/contracts";

/** Remote Link first shipped in 2.66. Protocol evidence takes precedence over this fallback. */
export const OPENCODEX_CAPABILITIES = {
  remoteLink: { minimumVersion: "2.66.0", requiredFeatures: [] },
  managementRelay: { minimumVersion: null, requiredFeatures: ["link-management-relay"] },
  quotaPool: { minimumVersion: null, requiredFeatures: ["quota-pool/1"] },
  servedBy: { minimumVersion: null, requiredFeatures: ["served-by-header"] },
  hubClient: { minimumVersion: null, requiredFeatures: [] },
} as const;

type Peer = OpenCodexProtocolEvidence & { readonly version?: string | undefined };
type Capability = keyof typeof OPENCODEX_CAPABILITIES;

const versionParts = (version: string | undefined) => {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version ?? "");
  return match ? match.slice(1, 4).map(Number) : undefined;
};
const belowMinimum = (version: string | undefined, minimum: string) => {
  const actual = versionParts(version);
  const required = versionParts(minimum)!;
  if (!actual) return false;
  for (let index = 0; index < 3; index++) {
    if (actual[index] !== required[index]) return actual[index]! < required[index]!;
  }
  return false;
};

const protocolRange = (peer: Peer) => {
  const max = peer.protocol ?? peer.protocolVersion;
  const min = peer.minimumClientProtocol ?? max;
  return max !== undefined &&
    min !== undefined &&
    Number.isSafeInteger(max) &&
    Number.isSafeInteger(min) &&
    min > 0 &&
    max >= min
    ? { min, max }
    : undefined;
};
const relayAuth = (peer: Peer) =>
  peer.relayAuthVersion ??
  peer.features?.find((feature) => /^relay-auth\/\d+$/.test(feature))?.split("/")[1];

/**
 * OpenCodex's permission for this device as the Home states it, or undefined when this read
 * does not say: an OpenCodex before OCX-11, or a policy read from this machine's own config.
 * The hub-down policy reads it while the Home answers and keeps it for the outage; Fleet and
 * Settings show the same reading.
 */
export function homeLocalFallback(snapshot: OpenCodexInventorySnapshot): boolean | undefined {
  const fallback = snapshot.fallback;
  if (fallback === undefined) return undefined;
  // The Home lists every link, so a Child with no row has no permission.
  if (fallback.source === "home") return fallback.localFallback === true;
  if (fallback.source === "live" && snapshot.hubClient !== undefined) return fallback.localFallback;
  return undefined;
}

/** Unknown negotiation metadata is degraded; release drift alone never rejects a pair. */
export function openCodexPairVerdict(
  home: Peer,
  child: Peer,
  capabilities: ReadonlyArray<Capability> = ["remoteLink"],
): "compatible" | "degraded" | "incompatible" {
  const homeRange = protocolRange(home);
  const childRange = protocolRange(child);
  const homeAuth = relayAuth(home);
  const childAuth = relayAuth(child);
  if (homeAuth !== undefined && childAuth !== undefined && homeAuth !== childAuth)
    return "incompatible";
  if (
    homeRange &&
    childRange &&
    Math.max(homeRange.min, childRange.min) > Math.min(homeRange.max, childRange.max)
  )
    return "incompatible";

  let degraded = !homeRange || !childRange || homeAuth === undefined || childAuth === undefined;
  for (const peer of [home, child]) {
    for (const capability of capabilities) {
      const requirement = OPENCODEX_CAPABILITIES[capability];
      if (
        (!homeRange || !childRange) &&
        requirement.minimumVersion &&
        belowMinimum(peer.version, requirement.minimumVersion)
      )
        return "incompatible";
      if (peer.features === undefined && requirement.requiredFeatures.length > 0) {
        degraded = true;
      } else if (
        requirement.requiredFeatures.some((feature) => !peer.features?.includes(feature))
      ) {
        degraded = true;
      }
    }
  }
  return degraded ? "degraded" : "compatible";
}
