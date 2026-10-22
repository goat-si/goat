import { CLOUD_AGENT_PROVIDERS, ProviderDriverKind } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import { providerClients } from "../settings/providerDriverMeta";
import { resolveProviderInstanceAcpRegistryIconUrl } from "./ProviderInstanceIcon";

describe("cloud provider marks", () => {
  // Without a package icon the row falls back to initials, which read as a bare "cc" badge.
  it.each(CLOUD_AGENT_PROVIDERS)("%s has a vector mark for light and dark themes", (driver) => {
    const icon = providerClients.get(ProviderDriverKind.make(driver))?.icon;
    expect(icon?.paths.length).toBeGreaterThan(0);
    expect(icon?.fill.light).toMatch(/^#/u);
    expect(icon?.fill.dark).toMatch(/^#/u);
  });
});

describe("resolveProviderInstanceAcpRegistryIconUrl", () => {
  it("uses allowlisted catalog metadata and rejects untrusted overrides", () => {
    expect(
      resolveProviderInstanceAcpRegistryIconUrl({
        driverKind: ProviderDriverKind.make("acpRegistry"),
        agentId: "kilo",
        iconUrl: "https://cdn.agentclientprotocol.com/registry/icons/kilo.svg",
      }),
    ).toBe("https://cdn.agentclientprotocol.com/registry/icons/kilo.svg");
    expect(
      resolveProviderInstanceAcpRegistryIconUrl({
        driverKind: ProviderDriverKind.make("acpRegistry"),
        agentId: "generic-agent",
        iconUrl: "https://example.com/not-official.svg",
      }),
    ).toBe("https://cdn.agentclientprotocol.com/registry/v1/latest/generic-agent.svg");
  });
});
