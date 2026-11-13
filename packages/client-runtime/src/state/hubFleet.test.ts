import type { HostStatusEntry, OpenCodexInventorySnapshot } from "@goat/contracts";
import { describe, expect, it } from "@effect/vitest";

import { hubDeviceFacts, hubDeviceSeverity, hubRelayWarnings, hubSnapshot } from "./hubFleet.ts";
import { hubLinkOfMachine, hubRelayWarningLabel } from "./hubLinkTraffic.ts";

function inventory(
  role: "home" | "child" | "none",
  extra: Partial<OpenCodexInventorySnapshot> = {},
): OpenCodexInventorySnapshot {
  return {
    installed: true,
    binaries: [],
    ownership: "adopted",
    service: { available: false },
    runtime: {
      version: role === "home" ? "2.89.0" : "2.83.0",
      role: role === "child" ? "client" : "standalone",
      port: 10100,
      healthy: true,
      ready: true,
      // Matching protocol and relay-auth evidence on both sides makes a pair compatible.
      protocol: 3,
      minimumClientProtocol: 2,
      relayAuthVersion: "2",
      features: [],
    },
    link: {
      role,
      available: true,
      links:
        role === "home"
          ? [
              { id: "lnk_a", alias: "macmini-ts", tunnelPort: 54958, state: "connected" },
              { id: "lnk_b", alias: "lidge-ts", tunnelPort: 42255, state: "reconnecting" },
            ]
          : [],
      childSettingsApplied: null,
      ...(role === "home" ? { homeName: "jun-mbp" } : {}),
    },
    ...extra,
  };
}

function entry(host: string | null, opencodex?: OpenCodexInventorySnapshot): HostStatusEntry {
  return {
    host,
    reachability: "ok",
    metrics: {
      sampledAt: 0,
      cpuCount: 8,
      cpuUtilization: null,
      availableMemoryBytes: 8,
      totalMemoryBytes: 16,
      loadAvg: null,
      disk: null,
      threads: { running: 0, waiting: 0, queued: 0 },
      quotas: [],
      ...(opencodex ? { opencodex } : {}),
    },
  };
}

describe("hubSnapshot", () => {
  it("is null when no host is an OpenCodex Home", () => {
    expect(hubSnapshot([{ key: "a", label: "a", entry: entry(null, inventory("child")) }])).toBe(
      null,
    );
  });

  it("lists the Home's links first, then reachable machines by their own transport", () => {
    const hub = hubSnapshot([
      { key: "home", label: "jun-mbp", entry: entry(null, inventory("home")) },
      {
        key: "mini",
        label: "mini",
        entry: entry(
          "mini",
          inventory("none", {
            hubClient: { state: "connected", apiKeyId: "key_1" },
            fallback: { source: "live", localFallback: true },
          }),
        ),
      },
      // Fleet rows name another environment by its label, with host null.
      { key: "env-macmini", label: "macmini-ts", entry: entry(null, inventory("child")) },
      { key: "gone", label: "gone", entry: { host: "gone", reachability: "unreachable" } },
      { key: "plain", label: "plain", entry: entry("plain") },
    ]);
    expect(hub?.homeName).toBe("jun-mbp");
    expect(hub?.homeKey).toBe("home");
    expect(
      hub?.devices.map(({ alias, transport, reachability, tunnel, versionVerdict, fallback }) => ({
        alias,
        transport,
        reachability,
        tunnel,
        versionVerdict,
        fallback,
      })),
    ).toEqual([
      {
        alias: "macmini-ts",
        transport: "remote-link",
        reachability: "ok",
        tunnel: "connected",
        versionVerdict: "compatible",
        fallback: "unknown",
      },
      // Linked but not read: it still shows, with what the Home knows.
      {
        alias: "lidge-ts",
        transport: "remote-link",
        reachability: "not-connected",
        tunnel: "reconnecting",
        versionVerdict: null,
        fallback: "unknown",
      },
      {
        alias: "mini",
        transport: "hub-client",
        reachability: "ok",
        tunnel: null,
        versionVerdict: "compatible",
        fallback: "on",
      },
      // A machine without OpenCodex is standalone and has no version verdict.
      {
        alias: "plain",
        transport: "standalone",
        reachability: "ok",
        tunnel: null,
        versionVerdict: null,
        fallback: "unknown",
      },
    ]);
    expect(hubDeviceSeverity(hub!.devices[0]!)).toBe(null);
    expect(hubDeviceSeverity(hub!.devices[1]!)).toBe("warning");
    expect(hubDeviceFacts(hub!.devices[1]!)).toEqual([
      "no GOAT connection",
      "parity not verified",
      "tunnel reconnecting",
      "OpenCodex not read",
      "OpenCodex fallback unknown",
    ]);
  });

  it("carries the device's parity and pressure, and a relay-auth split is incompatible", () => {
    const child = inventory("child");
    const hub = hubSnapshot([
      { key: "home", label: "home", entry: entry(null, inventory("home")) },
      {
        key: "macmini-ts",
        label: "macmini-ts",
        entry: {
          ...entry("macmini-ts", {
            ...child,
            runtime: { ...child.runtime, relayAuthVersion: "1" },
            // The Home lists every link; no permission in its row means no local fallback.
            fallback: { source: "home" },
          }),
          parity: {
            verdict: "degraded",
            checkedAt: 0,
            failingCheckIds: ["P6"],
            checks: [{ id: "P6", status: "failed", reason: "settings differ" }],
          },
          pressure: {
            level: "elevated",
            since: "2026-10-22T00:00:00.000Z",
            reasons: [],
            loadPerCore: null,
            eventLoopDelayMs: null,
          },
        },
      },
    ]);
    const device = hub!.devices[0]!;
    expect(device.versionVerdict).toBe("incompatible");
    expect(hubDeviceSeverity(device)).toBe("destructive");
    expect(hubDeviceFacts(device)).toEqual([
      "parity degraded (P6)",
      "tunnel connected",
      "OpenCodex 2.83.0, incompatible",
      "OpenCodex fallback off",
      "pressure elevated",
      "link traffic not measured",
    ]);
  });
});

describe("hubVersionLabel", () => {
  it("names OpenCodex from --version when no service answers, and a slow one as slow", () => {
    const { version: _version, ...unread } = inventory("none").runtime;
    const runtime = { ...unread, healthy: false, ready: false };
    const hub = hubSnapshot([
      { key: "home", label: "home", entry: entry(null, inventory("home")) },
      {
        key: "board",
        label: "board",
        entry: entry(
          "board",
          inventory("none", {
            runtime,
            binaries: [{ path: "/home/dietpi/.local/bin/ocx", version: "2.92.0" }],
          }),
        ),
      },
      {
        key: "zero",
        label: "zero",
        entry: entry(
          "zero",
          inventory("none", { installed: false, ownership: "none", runtime, slow: true }),
        ),
      },
    ]);
    const facts = (alias: string) =>
      hubDeviceFacts(hub!.devices.find((device) => device.alias === alias)!);
    expect(facts("board")).toContain("OpenCodex 2.92.0");
    expect(facts("zero")).toContain("OpenCodex slow to answer");
  });
});

describe("link traffic", () => {
  const window = (total: number, relay: number, measuredMs: number, direct = total - relay) => ({
    toHomeBytes: total,
    fromHomeBytes: total / 10,
    relayToHomeBytes: relay,
    relayFromHomeBytes: relay / 10,
    directToHomeBytes: direct,
    directFromHomeBytes: direct / 10,
    measuredMs,
  });
  const home = (
    links: OpenCodexInventorySnapshot["link"]["links"],
    relayWarning?: { relayBytes: number; thresholdBytes: number },
  ) => {
    const base = inventory("home");
    return entry(null, {
      ...base,
      link: { ...base.link, links, ...(relayWarning ? { relayWarning } : {}) },
    });
  };

  it("shows a connected Child's relay bytes each way, its route and its transport", () => {
    const hub = hubSnapshot([
      {
        key: "home",
        label: "home",
        entry: home([
          {
            id: "lnk_a",
            alias: "macmini-ts",
            tunnelPort: 54958,
            state: "connected",
            route: { name: "pen-macmini", via: "relay" },
            transport: "http",
            traffic: {
              hour: window(1_200_000_000, 1_200_000_000, 3_600_000),
              day: window(16_000_000_000, 14_000_000_000, 86_400_000),
              warning: { thresholdBytes: 5_000_000_000 },
            },
          },
        ]),
      },
    ]);
    const device = hub!.devices[0]!;
    expect(hubDeviceSeverity(device)).toBe("warning");
    expect(hubDeviceFacts(device).slice(-5)).toEqual([
      "over 5 GB through the relay in 24 h",
      "via relay pen-macmini",
      "HTTP",
      "relay ↑1.2 GB ↓120 MB last hour · ↑14 GB ↓1.4 GB in 24 h",
      "direct ↑0 B ↓0 B last hour · ↑2 GB ↓200 MB in 24 h",
    ]);
  });

  it("reads what the Home does not report as not measured, and a short measurement as short", () => {
    const hub = hubSnapshot([
      {
        key: "home",
        label: "home",
        entry: home([
          { id: "lnk_a", alias: "old", tunnelPort: 54958, state: "connected" },
          {
            id: "lnk_b",
            alias: "lan",
            tunnelPort: 54959,
            state: "connected",
            route: { name: "lan" },
            traffic: { hour: window(0, 0, 600_000), day: window(0, 0, 600_000) },
          },
          { id: "lnk_c", alias: "down", tunnelPort: 54960, state: "reconnecting" },
        ]),
      },
    ]);
    const facts = hub!.devices.map((device) => hubDeviceFacts(device).slice(-4));
    expect(facts[0]).toContain("link traffic not measured");
    expect(facts[1]).toEqual([
      "route lan",
      "transport not measured",
      "nothing sent in 24 h",
      "measured over 10 min",
    ]);
    expect(hubDeviceFacts(hub!.devices[2]!).join(" ")).not.toContain("measured");
  });

  it("carries the hub-wide relay warning, and none below the threshold", () => {
    const warning = { relayBytes: 31_000_000_000, thresholdBytes: 30_000_000_000 };
    const [only] = hubRelayWarnings([{ key: "home", label: "home", entry: home([], warning) }]);
    expect(hubRelayWarningLabel(only!.warning)).toBe(
      "Children sent 31 GB through the Pen relay in 24 h (warning at 30 GB). Nothing is stopped.",
    );
    expect(hubRelayWarnings([{ key: "home", label: "home", entry: home([]) }])).toEqual([]);
  });

  it("never calls bytes without a confirmed route direct, and says what the Home did not report", () => {
    const hub = hubSnapshot([
      {
        key: "home",
        label: "home",
        entry: home([
          {
            id: "lnk_a",
            alias: "macmini-ts",
            tunnelPort: 54958,
            state: "connected",
            route: { name: "pen-macmini" },
            traffic: {
              hour: window(1_000_000_000, 0, 3_600_000, 0),
              day: window(10_000_000_000, 0, 86_400_000, 0),
            },
          },
        ]),
      },
    ]);
    const facts = hubDeviceFacts(hub!.devices[0]!);
    expect(facts.slice(-3)).toEqual([
      "route pen-macmini",
      "transport not measured",
      "route not confirmed ↑1 GB ↓100 MB last hour · ↑10 GB ↓1 GB in 24 h",
    ]);
    expect(facts.join(" ")).not.toMatch(/none through a relay|not via relay|direct/u);
  });

  it("lists each machine's own relay warning, also one whose last link went while another is the Home", () => {
    const base = inventory("none");
    const warning = { relayBytes: 31_000_000_000, thresholdBytes: 30_000_000_000 };
    const sources = [
      { key: "b", label: "studio", entry: entry(null, inventory("home")) },
      {
        key: "a",
        label: "mini",
        entry: entry("mini", { ...base, link: { ...base.link, relayWarning: warning } }),
      },
    ];
    expect(hubSnapshot(sources)?.homeKey).toBe("b");
    expect(hubRelayWarnings(sources)).toEqual([{ key: "a", label: "mini", warning }]);
  });
});

describe("hubLinkOfMachine", () => {
  const devices = [
    { alias: "macmini-ts", tunnel: "connected" as const },
    { alias: "studio", tunnel: null },
  ];
  const machine = (label: string, sshAlias: string | null = null, reported: string[] = []) => ({
    label,
    sshHost: sshAlias === null ? null : { alias: sshAlias },
    reportedAliases: reported.map((alias) => ({ alias })),
  });

  it("finds a Fleet machine's Remote Link Child by its dispatcher alias, a reported alias or its label", () => {
    expect(hubLinkOfMachine(devices, machine("Mac mini", "macmini-ts"))?.alias).toBe("macmini-ts");
    expect(hubLinkOfMachine(devices, machine("Mac mini", null, ["macmini-ts"]))?.alias).toBe(
      "macmini-ts",
    );
    expect(hubLinkOfMachine(devices, machine("macmini-ts"))?.alias).toBe("macmini-ts");
  });

  it("never matches a machine that is not a linked Child", () => {
    expect(hubLinkOfMachine(devices, machine("studio"))).toBe(null);
    expect(hubLinkOfMachine(devices, machine("other", "other-ts"))).toBe(null);
  });
});
