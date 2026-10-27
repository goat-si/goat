import {
  type ChildReadyDevice,
  type ChildReadyFailure,
  type ChildReadyProof,
  childReadyProofIsCurrent,
  type ProviderInstanceConfig,
} from "@goat/contracts";

import * as CodexRoute from "../provider/CodexRouteService.ts";

/** What is true on this Child now, to hold a proof against. */
export interface ChildReadyFacts {
  readonly now: number;
  readonly device: ChildReadyDevice;
  readonly listenerInstanceId: string | undefined;
  readonly settingsDigest: string | undefined;
  readonly catalogDigest: string | undefined;
  readonly instance: ProviderInstanceConfig | undefined;
  readonly executable: { readonly path: string; readonly version: string } | undefined;
  /** Digest of the zero-count attestation now, or undefined when it cannot be read. */
  readonly localAccountsDigest: string | undefined;
  /** OpenCodex's link connection generation now, or undefined when it does not report one. */
  readonly connectionGeneration: string | undefined;
}

/**
 * The first recorded fact that no longer holds, or undefined while the proof stands. A link that
 * reconnected, even with the same link and listener ids, has a new connection generation.
 */
export const bindingFailure = (
  proof: ChildReadyProof,
  facts: ChildReadyFacts,
): ChildReadyFailure["code"] | undefined => {
  if (!childReadyProofIsCurrent(proof, facts.now)) return "proof_expired";
  if (facts.device.connection.role !== "client" || facts.device.connection.linkId !== proof.linkId)
    return "link_changed";
  // An OpenCodex that reports no connection generation cannot show the link stayed up.
  if (facts.connectionGeneration === undefined) return "attribution_unproven";
  if (facts.connectionGeneration !== proof.linkConnectionGeneration) return "link_changed";
  if (
    facts.listenerInstanceId !== proof.listenerInstanceId ||
    facts.settingsDigest !== proof.settingsDigest ||
    facts.catalogDigest !== proof.catalogDigest ||
    facts.instance === undefined ||
    CodexRoute.instanceFingerprint(facts.instance) !== proof.configFingerprint ||
    facts.executable?.path !== proof.executablePath ||
    facts.executable.version !== proof.executableVersion
  )
    return "route_unverified";
  if (facts.localAccountsDigest !== proof.localAccountsDigest) return "attribution_unproven";
  return undefined;
};
