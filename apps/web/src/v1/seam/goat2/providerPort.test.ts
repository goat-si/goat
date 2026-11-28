// The fake host's provider data passes v1's own schemas where it enters the lifted screens: every entry becomes a v1
// ServerProvider, registry/auth/install values decode as v1 results, and host instances fold into v1 settings rows.
import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";
import { AcpRegistrySearchResult, DEFAULT_SERVER_SETTINGS, ProviderAuthState, ProviderInstallState } from "@goat/contracts";
import { DEMO_REGISTRY, FakeProviders, demoProviderEntries } from "../../../host/fakeProviders.ts";
import { toServerProvider, withHostInstances, type Goat2ProviderEntry } from "./providerPort";

const AT = "2026-11-29T00:00:00.000Z";

describe("provider seam: fake host data through v1 schemas", () => {
  it("every demo entry decodes as a v1 ServerProvider with the probe's state", () => {
    for (const entry of demoProviderEntries(AT)) {
      const p = toServerProvider(entry as unknown as Goat2ProviderEntry);
      expect(p.instanceId).toBe(entry.instanceId);
      expect(p.installed).toBe(entry.probe.installed);
      expect(p.auth.status).toBe(entry.probe.auth.status);
    }
  });
  it("registry search, auth and install values decode with v1's result schemas", () => {
    const f = new FakeProviders(demoProviderEntries(AT), DEMO_REGISTRY, { now: () => AT });
    const search = f.run({ type: "search_acp_registry", query: "" });
    expect(Schema.decodeUnknownSync(AcpRegistrySearchResult)(search?.ok ? search.value.registrySearch : null).agents).toHaveLength(4);
    const auth = f.run({ type: "provider_auth_start", instanceId: "claudeAgent" });
    expect(Schema.decodeUnknownSync(ProviderAuthState)(auth?.ok ? auth.value.authState : null).phase).toBe("waiting");
    const install = f.run({ type: "provider_install_start", instanceId: "muse" });
    expect(Schema.decodeUnknownSync(ProviderInstallState)(install?.ok ? install.value.installState : null).phase).toBe("downloading");
  });
  it("host instances fold into v1 settings: registry agents and named instances get rows, plain defaults stay implicit", () => {
    const s = withHostInstances(DEFAULT_SERVER_SETTINGS, demoProviderEntries(AT) as unknown as Goat2ProviderEntry[]);
    expect(s.providerInstances["acp-kimi-code" as never]).toMatchObject({ driver: "acpRegistry", enabled: true, displayName: "Kimi Code", config: { agentId: "kimi-code" } });
    expect(s.providerInstances["codex" as never]).toBeUndefined();
    expect(withHostInstances(s, demoProviderEntries(AT) as unknown as Goat2ProviderEntry[])).toBe(s);
  });
});
