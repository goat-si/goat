import type { OpenCodexInventorySnapshot } from "@goat/contracts";
import fleet from "../opencodex/fixtures/fleet.json" with { type: "json" };
import evidence from "./fixtures/parity.json" with { type: "json" };

export function fleetSnapshot(
  alias: "home" | "mac-studio" | "macmini-ts" | "lidge-ts",
): OpenCodexInventorySnapshot {
  const fixture = fleet[alias];
  const child = alias !== "home";
  const linkId = fleet.home.link.links.find((link) => link.alias === alias)?.id;
  return {
    installed: true,
    binaries: [],
    ownership: "adopted",
    service: { available: false },
    runtime: {
      healthy: true,
      ready: true,
      role: child ? "client" : "standalone",
      version: fixture.version,
      port: 10100,
    },
    link: {
      role: child ? "child" : "home",
      available: true,
      links: child ? [] : fleet.home.link.links.map((link) => ({ ...link, state: "connected" })),
      childSettingsApplied: fixture.childSettingsApplied,
    },
    parityEvidence: {
      observedAt: 100_000,
      healthRole: child ? "client" : "standalone",
      ...(child && linkId ? { childLinkId: linkId } : {}),
      ...(!child ? { instanceId: evidence.homeInstanceId } : {}),
      modelsStatus: 200,
      catalogDigest: evidence.catalogDigest,
      ...(!child || fixture.childSettingsApplied
        ? { settingsDigest: evidence.settingsDigest }
        : {}),
      ...(child && fixture.childSettingsApplied && linkId ? { settingsLinkId: linkId } : {}),
      wiring: [{ status: "ok", reason: "Fixture clients use local OpenCodex." }],
      localProviderCount: 0,
    },
  };
}
