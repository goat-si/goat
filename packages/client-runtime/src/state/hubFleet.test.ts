import type { HostStatusEntry, OpenCodexInventorySnapshot } from "@goat/contracts";
import { describe, expect, it } from "@effect/vitest";

import { hubDeviceFacts, hubDeviceSeverity, hubSnapshot } from "./hubFleet.ts";

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
          inventory("none", { hubClient: { state: "connected", apiKeyId: "key_1" } }),
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
      hub?.devices.map(({ alias, transport, reachability, tunnel, versionVerdict }) => ({
        alias,
        transport,
        reachability,
        tunnel,
        versionVerdict,
      })),
    ).toEqual([
      {
        alias: "macmini-ts",
        transport: "remote-link",
        reachability: "ok",
        tunnel: "connected",
        versionVerdict: "compatible",
      },
      // Linked but not read: it still shows, with what the Home knows.
      {
        alias: "lidge-ts",
        transport: "remote-link",
        reachability: "not-connected",
        tunnel: "reconnecting",
        versionVerdict: null,
      },
      {
        alias: "mini",
        transport: "hub-client",
        reachability: "ok",
        tunnel: null,
        versionVerdict: "compatible",
      },
      // A machine without OpenCodex is standalone and has no version verdict.
      {
        alias: "plain",
        transport: "standalone",
        reachability: "ok",
        tunnel: null,
        versionVerdict: null,
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
      "OpenCodex fallback unknown",
      "pressure elevated",
    ]);
  });
});
