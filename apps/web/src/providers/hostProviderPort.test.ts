// The provider adapter over the fake host: v1 method calls become the approved frames and come back as v1 results.
import { describe, expect, it } from "vitest";
import { FakeHost } from "../host/fakeHost.ts";
import { FakeProviders, demoProviderEntries } from "../host/fakeProviders.ts";
import { HostClient } from "../host/client.ts";
import { memoryStorage } from "../host/outbox.ts";
import { demoWorld } from "../host/demoWorld.ts";
import { hostProviderPort } from "./hostProviderPort.ts";
import type { ProviderAuthState, ProviderInstallState, ServerProviderEntry } from "./wire.ts";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const AT = "2026-11-29T00:00:00.000Z";
const setup = (opts: { providers?: boolean; connect?: "open" | "never" } = {}) => {
  const providers = new FakeProviders(demoProviderEntries(AT), undefined, { now: () => AT, stepMs: 2 });
  const fake = new FakeHost({ ...demoWorld(), ...(opts.providers === false ? {} : { providers }) }, { connect: opts.connect ?? "open" });
  const client = new HostClient(fake, { outbox: memoryStorage(), cache: null, demo: "test" });
  return { fake, client, providers, port: hostProviderPort(client) };
};
const LOCAL_KINDS = ["codex", "claudeAgent", "grok", "fx", "antigravity", "acpRegistry", "opencode", "cursor", "muse", "pi", "omo"];

describe("hostProviderPort + fake host", () => {
  it("streams the provider list: every local v1 driver kind", async () => {
    const { port } = setup();
    await tick(5);
    const lists: ServerProviderEntry[][] = [];
    const stop = port.subscribe((l) => lists.push([...l] as ServerProviderEntry[]));
    await tick(5);
    const list = lists.at(-1)!;
    expect(new Set(list.map((e) => e.driver))).toEqual(new Set(LOCAL_KINDS));
    expect(list.find((e) => e.instanceId === "codex")!.probe).toMatchObject({ installed: true, version: "0.167.0", auth: { status: "authenticated" } });
    expect(list.find((e) => e.instanceId === "grok")!.probe).toMatchObject({ installed: false, status: "error" });
    stop();
  });

  it("refresh resolves with the list the host sends after it", async () => {
    const { port, providers } = setup();
    await tick(5);
    providers.entries[0]!.probe = { ...providers.entries[0]!.probe, version: "0.168.0" };
    const r = await port.call("server.refreshProviders", { instanceId: "codex" }) as { providers: ServerProviderEntry[] };
    expect(r.providers.find((e) => e.instanceId === "codex")!.probe.version).toBe("0.168.0");
  });

  it("searches and prepares registry agents, then adds one as an instance", async () => {
    const { port, fake } = setup();
    await tick(5);
    const found = await port.call("server.searchAcpRegistry", { query: "ki" }) as { agents: Array<{ id: string }> };
    expect(found.agents.map((a) => a.id)).toEqual(["kimi-code", "kilo", "kiro"]);
    const prepared = await port.call("server.prepareAcpRegistryAgent", { agentId: "kiro" });
    expect(prepared).toEqual({ agentId: "kiro", version: "3.6.2", distribution: "binary", prepared: true });
    await port.call("goat2.setProviderInstance", { instanceId: "acp-kiro", driver: "acpRegistry", acpAgentId: "kiro", enabled: true, displayName: "Kiro CLI" });
    expect(fake.received.at(-1)).toMatchObject({ type: "set_provider_instance", instanceId: "acp-kiro", acpAgentId: "kiro", enabled: true });
    const r = await port.call("server.refreshProviders", {}) as { providers: ServerProviderEntry[] };
    expect(r.providers.find((e) => e.instanceId === "acp-kiro")).toMatchObject({ driver: "acpRegistry", acpAgentId: "kiro", probe: { version: "3.6.2" } });
  });

  it("sign-in: start returns the AuthRequired URL, the watch stream follows the flow to success", async () => {
    const { port, providers } = setup();
    await tick(5);
    const seen: ProviderAuthState[] = [];
    const stop = port.watch("providerAuth.subscribe", { instanceId: "antigravity" }, (v) => seen.push(v as ProviderAuthState));
    await tick(5);
    expect(seen.at(-1)!.phase).toBe("idle");
    const started = await port.call("providerAuth.start", { instanceId: "antigravity" }) as ProviderAuthState;
    expect(started).toMatchObject({ phase: "waiting", authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?client_id=antigravity-demo" });
    await tick(5);
    expect(seen.at(-1)!.phase).toBe("waiting");
    providers.completeAuth("antigravity");
    await tick(5);
    expect(seen.at(-1)!.phase).toBe("succeeded");
    stop();
  });

  it("install: start, progress through v1's phases, the probe reports the CLI", async () => {
    const { port } = setup();
    await tick(5);
    const phases: string[] = [];
    const stop = port.watch("providerInstall.subscribe", { instanceId: "grok" }, (v) => phases.push((v as ProviderInstallState).phase));
    const started = await port.call("providerInstall.start", { instanceId: "grok" }) as ProviderInstallState;
    expect(started.phase).toBe("downloading");
    await tick(40);
    expect(phases).toContain("verifying");
    expect(phases.at(-1)).toBe("succeeded");
    const r = await port.call("server.refreshProviders", { instanceId: "grok" }) as { providers: ServerProviderEntry[] };
    expect(r.providers.find((e) => e.instanceId === "grok")!.probe).toMatchObject({ installed: true, cli: "present" });
    stop();
  });

  it("refuses what GOAT 2 does not serve, and host refusals, with a sentence", async () => {
    const { port } = setup();
    await tick(5);
    await expect(port.call("providerAuth.respond", {})).rejects.toThrow(/not available in GOAT yet/);
    await expect(port.call("providerAuth.start", { instanceId: "nope" })).rejects.toThrow("No provider instance nope.");
  });

  it("a scene without a provider world: empty list, commands refused as unavailable", async () => {
    const { port } = setup({ providers: false });
    await tick(5);
    const lists: unknown[][] = [];
    port.subscribe((l) => lists.push([...l]));
    await tick(5);
    expect(lists.at(-1)).toEqual([]);
    await expect(port.call("server.searchAcpRegistry", { query: "" })).rejects.toThrow(/does not serve search_acp_registry/);
  });

  it("offline: calls fail with the connection sentence", async () => {
    const { port } = setup({ connect: "never" });
    await expect(port.call("server.searchAcpRegistry", { query: "" })).rejects.toThrow("Not connected to the host.");
  });
});

describe("hostProviderPort: refresh correlation and cleanup (reviews 1 and 2)", () => {
  class SilentRefresh extends FakeProviders {
    /** A host that answers refresh_providers without sending a providers frame. */
    override run(body: { type: string } & Record<string, unknown>) {
      return body.type === "refresh_providers" ? { ok: true as const, value: {} } : super.run(body);
    }
  }
  const make = (providers: FakeProviders) => {
    const fake = new FakeHost({ ...demoWorld(), providers }, { connect: "open" });
    const client = new HostClient(fake, { outbox: memoryStorage(), cache: null, demo: "test" });
    return { fake, client, port: hostProviderPort(client) };
  };

  it("a refresh whose list never comes is an error, not the old list", async () => {
    const { port } = make(new SilentRefresh(demoProviderEntries(AT), undefined, { now: () => AT }));
    await tick(5);
    await expect(port.call("server.refreshProviders", {})).rejects.toThrow("The host did not send its provider list for the refresh.");
  });

  it("a frame that arrives after the result never answers the refresh", async () => {
    class LateList extends FakeProviders {
      /** Answers first, then sends a list: the reverse of the wire's order. */
      override run(body: { type: string } & Record<string, unknown>) {
        if (body.type !== "refresh_providers") return super.run(body);
        setTimeout(() => super.run(body), 0); // a later socket message
        return { ok: true as const, value: {} };
      }
    }
    const { port } = make(new LateList(demoProviderEntries(AT), undefined, { now: () => AT }));
    await tick(5); // first list delivered
    await expect(port.call("server.refreshProviders", {})).rejects.toThrow(/did not send its provider list/);
  });

  it("another change landing during a refresh: the refresh still resolves with its own, newest list", async () => {
    class Busy extends FakeProviders {
      /** Another change's frame goes out after the request, then the refresh's own frame, then the result. */
      override run(body: { type: string } & Record<string, unknown>) {
        if (body.type !== "refresh_providers") return super.run(body);
        const grok = this.entries.find((e) => e.instanceId === "grok")!;
        grok.probe = { ...grok.probe, message: "other change" };
        super.run({ type: "refresh_providers", instanceId: "grok" });
        this.entries[0]!.probe = { ...this.entries[0]!.probe, version: "0.169.0" };
        return super.run(body);
      }
    }
    const { port } = make(new Busy(demoProviderEntries(AT), undefined, { now: () => AT }));
    const frames: ServerProviderEntry[][] = [];
    port.subscribe((l) => frames.push(l as ServerProviderEntry[]));
    await tick(5);
    const before = frames.length;
    const r = await port.call("server.refreshProviders", { instanceId: "codex" }) as { providers: ServerProviderEntry[] };
    expect(frames.length - before).toBe(2);
    expect(r.providers).toBe(frames.at(-1));
    expect(r.providers.find((e) => e.instanceId === "codex")!.probe.version).toBe("0.169.0");
  });

  it("other commands resolve from their result without waiting for a list", async () => {
    class NoList extends FakeProviders { override onList() { return () => {}; } }
    const { port } = make(new NoList(demoProviderEntries(AT), undefined, { now: () => AT }));
    await tick(5);
    const found = await port.call("server.searchAcpRegistry", { query: "qwen" }) as { agents: Array<{ id: string }> };
    expect(found.agents.map((a) => a.id)).toEqual(["qwen-code"]);
  });

  it("dispose ends the one providers subscription", async () => {
    const { port, fake } = make(new FakeProviders(demoProviderEntries(AT), undefined, { now: () => AT }));
    await tick(5);
    const subs = fake.received.filter((f) => (f as { type: string }).type === "subscribe_providers");
    expect(subs).toHaveLength(1);
    port.dispose();
    expect(fake.received.at(-1)).toEqual({ type: "unsubscribe", subId: (subs[0] as unknown as { subId: string }).subId });
  });

  it("dispose settles calls still in flight at once, and later calls are refused", async () => {
    const { port } = make(new FakeProviders(demoProviderEntries(AT), undefined, { now: () => AT }));
    await tick(5);
    const refresh = port.call("server.refreshProviders", {});
    const search = port.call("server.searchAcpRegistry", { query: "ki" });
    port.dispose();
    await expect(refresh).rejects.toThrow("The provider connection was closed.");
    await expect(search).rejects.toThrow("The provider connection was closed.");
    await expect(port.call("server.refreshProviders", {})).rejects.toThrow("The provider connection was closed.");
    await tick(5); // the host's late results land on a disposed port without effect
  });
});
