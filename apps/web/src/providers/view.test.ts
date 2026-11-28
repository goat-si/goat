// The provider screens' decisions (providers/view.ts) on the boards' fake data: what counts as added, each state's
// dot and next step, the catalog's sections and actions, the first-run list.
import { describe, expect, it } from "vitest";
import { DEMO_REGISTRY, demoProviderEntries, firstRunProviderEntries } from "../host/fakeProviders.ts";
import { addedProviders, catalog, detected, enableBody, nextInstanceId, providerState, rowLine, unchecked } from "./view.ts";
import type { ServerProviderEntry } from "./wire.ts";

const AT = "2026-11-29T00:00:00.000Z";
const demo = () => demoProviderEntries(AT);
const byId = (list: ServerProviderEntry[], id: string) => list.find((e) => e.instanceId === id)!;

describe("added providers", () => {
  it("switched on or configured providers are added; off defaults are not, unless switched off from their page", () => {
    const ids = addedProviders(demo(), []).map((e) => e.instanceId);
    expect(ids).toEqual(["codex", "codex-2", "claudeAgent", "cursor", "opencode", "antigravity", "pi", "omo", "acp-kimi-code", "acp-kilo"]);
    expect(addedProviders(demo(), ["grok"]).map((e) => e.instanceId)).toContain("grok");
    const kimiOff = demo().map((e) => (e.instanceId === "acp-kimi-code" ? { ...e, enabled: false } : e));
    expect(addedProviders(kimiOff, []).map((e) => e.instanceId)).toContain("acp-kimi-code"); // a registry agent stays configured
    expect(addedProviders(kimiOff, [], ["acp-kimi-code"]).map((e) => e.instanceId)).not.toContain("acp-kimi-code"); // removed here
    expect(addedProviders(demo(), [], ["acp-kimi-code"]).map((e) => e.instanceId)).toContain("acp-kimi-code"); // switched on elsewhere: back
    expect(catalog(kimiOff, [], DEMO_REGISTRY, "all", "", ["acp-kimi-code"]).find((i) => i.key === "acp:kimi-code")).toMatchObject({ action: { kind: "registry" } });
  });
});

describe("state", () => {
  it("names the next step with the board colours", () => {
    const list = demo();
    expect(providerState(byId(list, "codex"))).toMatchObject({ dot: "green", word: "Ready", need: "none" });
    expect(providerState(byId(list, "claudeAgent"))).toMatchObject({ dot: "blue", word: "Needs sign-in", need: "sign-in" });
    expect(providerState(byId(list, "antigravity"))).toMatchObject({ dot: "blue", need: "sign-in" }); // pending engine sign-in link
    expect(providerState(byId(list, "omo"))).toMatchObject({ dot: "red", word: "Needs repair", need: "repair" });
    expect(providerState(byId(list, "muse"))).toMatchObject({ dot: "grey", word: "Off" });
    expect(providerState({ ...byId(list, "muse"), enabled: true })).toMatchObject({ dot: "blue", word: "Not installed", need: "install" });
    expect(providerState(byId(list, "acp-kilo"))).toMatchObject({ busy: "installing", word: "Installing · 62%" });
    expect(providerState({ ...byId(list, "codex"), probe: { ...byId(list, "codex").probe, status: "warning", auth: { status: "unknown" } } }))
      .toMatchObject({ dot: "grey", word: "Status unknown", need: "unknown" });
    expect(rowLine(byId(list, "codex"))).toBe("Ready · ChatGPT Pro");
    expect(providerState({ ...byId(list, "codex"), probe: { ...byId(list, "codex").probe, status: "warning", message: "Checking status…" } }))
      .toMatchObject({ dot: "grey", word: "Checking…" });
  });
});

describe("catalog", () => {
  it("installed but not added first, added kinds after them, then installs, presets and registry agents", () => {
    const items = catalog(demo(), [], DEMO_REGISTRY, "all", "");
    const mac = items.filter((i) => i.section === "mac");
    expect(mac.slice(0, 2).map((i) => [i.key, i.badge, i.action.kind])).toEqual([["grok", "Installed", "enable"], ["fx", "Installed", "enable"]]);
    expect(mac.find((i) => i.key === "codex")).toMatchObject({ badge: "Added", blurb: "Already added: 2 accounts." });
    const more = items.filter((i) => i.section === "more");
    expect(more.find((i) => i.key === "muse")).toMatchObject({ badge: "1-click install", action: { kind: "install", instanceId: "muse" } });
    expect(more.find((i) => i.key === "preset:omp")).toMatchObject({ action: { kind: "copy", text: "curl -fsSL https://omp.sh/install | sh" } });
    expect(more.find((i) => i.key === "acp:kiro")).toMatchObject({ action: { kind: "registry", agentId: "kiro" } });
    expect(items.find((i) => i.key === "acp:kimi-code")).toMatchObject({ badge: "Added", section: "mac" });
    // Cloud: platforms under All, counterparts only under the Cloud filter (principle 9); never addable in Part 2.
    expect(items.map((i) => i.key)).toContain("devinCloud");
    expect(items.map((i) => i.key)).not.toContain("claudeCloud");
    const cloud = catalog(demo(), [], DEMO_REGISTRY, "cloud", "");
    expect(cloud.map((i) => i.key).sort()).toEqual(["claudeCloud", "cursorCloud", "devinCloud"]);
    expect(cloud.every((i) => i.action.kind === "none")).toBe(true);
    expect(catalog(demo(), [], DEMO_REGISTRY, "ready", "").every((i) => i.installed)).toBe(true);
    expect(catalog(demo(), [], DEMO_REGISTRY, "all", "qwen").map((i) => i.key)).toEqual(["acp:qwen-code"]);
    expect(catalog(demo(), [], DEMO_REGISTRY, "all", "claude cloud").map((i) => i.key)).toEqual(["claudeCloud"]); // searchable under All
  });
  it("drivers this host build lacks show why they cannot be added", () => {
    const unserved = demo().map((e) => (e.instanceId === "muse" ? { ...e, probe: { ...e.probe, status: "disabled" as const, message: "This GOAT build does not include the Muse driver yet." } } : e));
    expect(catalog(unserved, [], [], "all", "").find((i) => i.key === "muse")).toMatchObject({ badge: "Not in this build", action: { kind: "none" } });
    // A host that reports only Codex (lane E slice 1): every other local kind is still in the catalog, with the reason.
    const codexOnly = demo().filter((e) => e.instanceId === "codex");
    const items = catalog(codexOnly, [], [], "all", "");
    const local = ["codex", "claudeAgent", "grok", "fx", "antigravity", "opencode", "cursor", "muse", "pi", "omo"];
    expect(local.every((k) => items.some((i) => i.key === k))).toBe(true);
    expect(items.find((i) => i.key === "claudeAgent")).toMatchObject({ badge: "Not in this build", action: { kind: "none", reason: "This GOAT build does not include the Claude driver yet." } });
  });
});

describe("switched-off instances", () => {
  it("their install state is unknown (status-only rows); turning one on keeps its stored name and agent", () => {
    const off = demo().map((e) => (e.instanceId === "grok" ? { ...e, probe: { ...e.probe, status: "disabled" as const } } : e));
    expect(catalog(off, [], [], "all", "").find((i) => i.key === "grok")).toMatchObject({ badge: "Not checked", installed: false, action: { kind: "enable" } });
    expect(detected(off, []).map((e) => e.instanceId)).not.toContain("grok");
    expect(unchecked(off, []).map((e) => e.instanceId)).toEqual(["grok"]);
    expect(enableBody({ ...byId(demo(), "codex"), enabled: false })).toEqual({ instanceId: "codex", driver: "codex", enabled: true, displayName: "Personal" });
    expect(enableBody(byId(demo(), "acp-kimi-code"))).toMatchObject({ acpAgentId: "kimi-code", displayName: "Kimi Code" });
  });
});

describe("first run and accounts", () => {
  it("lists installed, not added built-ins; the next account gets a free id", () => {
    expect(detected(firstRunProviderEntries(AT), []).map((e) => e.instanceId)).toEqual(["codex", "claudeAgent", "cursor"]);
    expect(detected(demo(), [])).toEqual(expect.arrayContaining([expect.objectContaining({ instanceId: "grok" }), expect.objectContaining({ instanceId: "fx" })]));
    expect(nextInstanceId(demo(), "codex")).toBe("codex-3");
    expect(nextInstanceId(demo(), "claudeAgent")).toBe("claudeAgent-2");
  });
});

