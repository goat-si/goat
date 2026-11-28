// v1 server.updateSettings in the seam (review 1 P1): what the host can store is sent and shown; anything else is
// refused with what was not saved, and nothing changes.
import { describe, expect, it } from "vitest";
import { AtomRegistry } from "effect/reactivity";
import { DEFAULT_SERVER_SETTINGS, ProviderInstanceId } from "@goat/contracts";
import { goat2SettingsAtom, installProviderPort, type ProviderPort } from "../goat2/providerPort";
import { GOAT2_ENVIRONMENT_ID } from "../goat2/environment";
import { serverEnvironment } from "./server";

const setup = () => {
  const calls: Array<[string, unknown]> = [];
  const port: ProviderPort = { subscribe: () => () => {}, watch: () => () => {}, call: async (method, payload) => { calls.push([method, payload]); return {}; } };
  installProviderPort(port);
  const registry = AtomRegistry.make();
  registry.set(goat2SettingsAtom, DEFAULT_SERVER_SETTINGS);
  const run = (input: unknown) => serverEnvironment.updateSettings.run(registry, { environmentId: GOAT2_ENVIRONMENT_ID, input: input as never });
  return { calls, registry, run };
};

describe("seam updateSettings", () => {
  it("sends v1's registry wizard instance to the host (agent kept, wizard defaults dropped) and shows it", async () => {
    const { calls, registry, run } = setup();
    const r = await run({ patch: {}, providerInstanceMutation: { operation: "create", instanceId: "acpRegistry_kiro_cli",
      instance: { driver: "acpRegistry", enabled: true, displayName: "Kiro CLI", config: { agentId: "kiro", distribution: "auto", registryIconUrl: "https://cdn.agentclientprotocol.com/registry/v1/latest/kiro.svg" } } } });
    expect(r._tag, String((r as unknown as { cause?: unknown }).cause)).toBe("Success");
    expect(calls).toEqual([["goat2.setProviderInstance", { instanceId: "acpRegistry_kiro_cli", driver: "acpRegistry", enabled: true, displayName: "Kiro CLI", acpAgentId: "kiro" }]]);
    expect(registry.get(goat2SettingsAtom).providerInstances[ProviderInstanceId.make("acpRegistry_kiro_cli")]).toBeDefined();
  });
  it("an on/off toggle is sent", async () => {
    const { calls, run } = setup();
    expect((await run({ patch: {}, providerInstanceMutation: { operation: "upsert", instanceId: "grok", instance: { driver: "grok", enabled: false } } }))._tag).toBe("Success");
    expect(calls).toEqual([["goat2.setProviderInstance", { instanceId: "grok", driver: "grok", enabled: false }]]);
  });
  it("settings the host does not store are refused, nothing sent or changed", async () => {
    const { calls, registry, run } = setup();
    const binary = await run({ patch: {}, providerInstanceMutation: { operation: "upsert", instanceId: "codex", instance: { driver: "codex", config: { binaryPath: "/opt/bin/codex" } } } });
    expect(binary._tag).toBe("Failure");
    expect(String((binary as unknown as { cause: unknown }).cause)).toMatch(/GOAT does not save this setting yet: providerInstances.codex/);
    const removal = await run({ patch: {}, providerInstanceMutation: { operation: "remove", instanceId: "grok" } });
    expect(String((removal as unknown as { cause: unknown }).cause)).toMatch(/Turn it off instead/);
    const other = await run({ patch: { enableAssistantStreaming: false } });
    expect(other._tag).toBe("Failure");
    expect(calls).toEqual([]);
    expect(registry.get(goat2SettingsAtom)).toEqual(DEFAULT_SERVER_SETTINGS);
  });
  it("a provider frame that lands while the host answers is kept; only the sent instance is laid on top (review 4)", async () => {
    const { registry, run } = setup();
    const pi = ProviderInstanceId.make("pi");
    installProviderPort({ subscribe: () => () => {}, watch: () => () => {}, call: async () => {
      const s = registry.get(goat2SettingsAtom);
      registry.set(goat2SettingsAtom, { ...s, providerInstances: { ...s.providerInstances, [pi]: { driver: "pi", enabled: false } } as never });
      return {};
    } });
    const r = await run({ patch: {}, providerInstanceMutation: { operation: "upsert", instanceId: "grok", instance: { driver: "grok", enabled: false } } });
    expect(r._tag).toBe("Success");
    const instances = registry.get(goat2SettingsAtom).providerInstances;
    expect(instances[pi]).toMatchObject({ driver: "pi", enabled: false });
    expect(instances[ProviderInstanceId.make("grok")]).toMatchObject({ driver: "grok", enabled: false });
  });
  it("a frame for the same instance that lands while the host answers wins over the sent value (review 5)", async () => {
    const { registry, run } = setup();
    const grok = ProviderInstanceId.make("grok");
    installProviderPort({ subscribe: () => () => {}, watch: () => () => {}, call: async () => {
      const s = registry.get(goat2SettingsAtom);
      registry.set(goat2SettingsAtom, { ...s, providerInstances: { ...s.providerInstances, [grok]: { driver: "grok", enabled: true, displayName: "Grok (other window)" } } as never });
      return {};
    } });
    const r = await run({ patch: {}, providerInstanceMutation: { operation: "upsert", instanceId: "grok", instance: { driver: "grok", enabled: false } } });
    expect(r._tag).toBe("Success");
    expect(registry.get(goat2SettingsAtom).providerInstances[grok]).toMatchObject({ enabled: true, displayName: "Grok (other window)" });
  });
});
