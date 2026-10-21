import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type HostStatusEntry,
  type HostStatusMetrics,
} from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  fleetHeatReasons,
  fleetHeatSignals,
  fleetHeatTier,
  fleetHostStatusNeeded,
  fleetMachineHeat,
  fleetMachineHeatEqual,
  matchFleetHostEntries,
  type FleetHeatSignals,
} from "./fleetHeat.ts";

const GIB = 1024 ** 3;

function metrics(overrides: Partial<HostStatusMetrics> = {}): HostStatusMetrics {
  return {
    sampledAt: 0,
    cpuUtilization: 0.1,
    cpuCount: 10,
    availableMemoryBytes: 48 * GIB,
    totalMemoryBytes: 64 * GIB,
    loadAvg: { oneMinute: 1, fiveMinutes: 1, fifteenMinutes: 1 },
    disk: null,
    threads: { running: 0, waiting: 0, queued: 0 },
    quotas: [],
    ...overrides,
  };
}

const signals = (overrides: Partial<FleetHeatSignals> = {}): FleetHeatSignals => ({
  cpuPercent: 10,
  loadPerCore: 0.1,
  memoryPercent: 30,
  quota: null,
  ...overrides,
});

const quotaOf = (usedPercent: number, unavailable = false) => ({
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  displayName: "Codex",
  fromCache: false,
  limits: {
    checkedAt: "2026-10-20T00:00:00.000Z",
    windows: [
      { id: "five_hour", kind: "session" as const, label: "5h", usedPercent: 10 },
      { id: "weekly", kind: "weekly" as const, label: "Weekly", usedPercent },
    ],
    ...(unavailable ? { unavailable: { reason: "probeFailed" as const } } : {}),
  },
});

describe("fleetHeatSignals", () => {
  it("reads CPU, load per core, memory, and the fullest quota window", () => {
    expect(
      fleetHeatSignals(
        metrics({
          cpuUtilization: 0.914,
          cpuCount: 10,
          loadAvg: { oneMinute: 17, fiveMinutes: 9, fifteenMinutes: 5 },
          availableMemoryBytes: 16 * GIB,
          quotas: [quotaOf(82)],
        }),
      ),
    ).toEqual({
      cpuPercent: 91,
      loadPerCore: 1.7,
      memoryPercent: 75,
      quota: { label: "Codex weekly", usedPercent: 82 },
    });
  });

  it("leaves out what the host cannot report", () => {
    expect(
      fleetHeatSignals(
        metrics({
          cpuUtilization: null,
          loadAvg: null,
          totalMemoryBytes: 0,
          quotas: [quotaOf(99, true)],
        }),
      ),
    ).toEqual({ cpuPercent: null, loadPerCore: null, memoryPercent: null, quota: null });
  });
});

describe("fleetHeatTier", () => {
  it.each([
    [signals(), "normal"],
    [signals({ cpuPercent: 59 }), "normal"],
    [signals({ cpuPercent: 60 }), "warm"],
    [signals({ cpuPercent: 80 }), "hot"],
    [signals({ cpuPercent: 92 }), "burning"],
    [signals({ loadPerCore: 0.7 }), "warm"],
    [signals({ loadPerCore: 1 }), "hot"],
    [signals({ loadPerCore: 1.5 }), "burning"],
    [signals({ memoryPercent: 80 }), "warm"],
    [signals({ memoryPercent: 90 }), "hot"],
    [signals({ memoryPercent: 95 }), "burning"],
    [signals({ quota: { label: "Codex weekly", usedPercent: 70 } }), "warm"],
    [signals({ quota: { label: "Codex weekly", usedPercent: 85 } }), "hot"],
    [signals({ quota: { label: "Codex weekly", usedPercent: 95 } }), "burning"],
    // The hottest signal wins.
    [signals({ cpuPercent: 65, loadPerCore: 1.6 }), "burning"],
    [signals({ cpuPercent: null, loadPerCore: null, memoryPercent: null }), "normal"],
  ] as const)("%o is %s", (input, tier) => {
    expect(fleetHeatTier(input)).toBe(tier);
  });

  it("rises on the first sample over a threshold", () => {
    expect(fleetHeatTier(signals({ cpuPercent: 93 }), "normal")).toBe("burning");
  });

  it("holds a tier until the signal falls a margin below its threshold", () => {
    // CPU burning at 92 with an 8 point margin: holds down to 84, then steps to hot.
    expect(fleetHeatTier(signals({ cpuPercent: 88 }), "burning")).toBe("burning");
    expect(fleetHeatTier(signals({ cpuPercent: 84 }), "burning")).toBe("burning");
    expect(fleetHeatTier(signals({ cpuPercent: 83 }), "burning")).toBe("hot");
    // Load per core: hot at 1.0 with a 0.15 margin.
    expect(fleetHeatTier(signals({ loadPerCore: 0.9 }), "hot")).toBe("hot");
    expect(fleetHeatTier(signals({ loadPerCore: 0.8 }), "hot")).toBe("warm");
  });

  it("never holds above the previous tier or below the current reading", () => {
    // Within the burning margin but previously only warm: rising applies, nothing more.
    expect(fleetHeatTier(signals({ cpuPercent: 88 }), "warm")).toBe("hot");
    // Fell straight to idle from burning: the margin no longer covers any tier.
    expect(fleetHeatTier(signals(), "burning")).toBe("normal");
  });

  it("does not flicker across a boundary on noisy samples", () => {
    let tier = fleetHeatTier(signals({ cpuPercent: 81 }));
    const seen = new Set([tier]);
    for (const cpuPercent of [79, 82, 76, 80, 78, 75, 81, 77]) {
      tier = fleetHeatTier(signals({ cpuPercent }), tier);
      seen.add(tier);
    }
    expect([...seen]).toEqual(["hot"]);
  });
});

describe("fleetHeatReasons", () => {
  it("lists only the hot signals, hottest first", () => {
    expect(
      fleetHeatReasons(
        signals({
          cpuPercent: 91,
          loadPerCore: 1.74,
          memoryPercent: 40,
          quota: { label: "Codex weekly", usedPercent: 82 },
        }),
      ),
    ).toEqual(["load 1.7/core", "CPU 91%", "Codex weekly 82%"]);
    expect(fleetHeatReasons(signals())).toEqual([]);
  });
});

describe("fleetMachineHeat", () => {
  const entry = (overrides: Partial<HostStatusEntry> = {}): HostStatusEntry => ({
    host: null,
    reachability: "ok",
    metrics: metrics(),
    ...overrides,
  });

  it("says why a machine is hot", () => {
    const heat = fleetMachineHeat(
      entry({
        metrics: metrics({
          cpuUtilization: 0.91,
          loadAvg: { oneMinute: 17, fiveMinutes: 17, fifteenMinutes: 17 },
        }),
      }),
    );
    expect(heat).toMatchObject({
      tier: "burning",
      status: "live",
      summary: "Burning: load 1.7/core · CPU 91%",
    });
  });

  it("summarizes a normal machine's load without calling it hot", () => {
    expect(fleetMachineHeat(entry())).toMatchObject({
      tier: "normal",
      summary: "CPU 10% · load 0.1/core · memory 25%",
    });
  });

  it("judges heat by load alone, whatever the host's version or protocol verdict", () => {
    const busy = metrics({ cpuUtilization: 0.95 });
    for (const extra of [
      { versionMismatch: true as const },
      { compatibility: "degraded" as const },
      { compatibility: "incompatible" as const },
    ]) {
      expect(fleetMachineHeat(entry({ metrics: busy, ...extra }))).toMatchObject({
        tier: "burning",
        status: "live",
      });
    }
  });

  it("shows no heat for stale, unreachable, unsupported, or unmatched machines", () => {
    const hot = metrics({ cpuUtilization: 0.99 });
    expect(
      fleetMachineHeat(entry({ reachability: "unreachable", lastKnown: true, metrics: hot })),
    ).toMatchObject({ tier: "normal", status: "stale" });
    expect(fleetMachineHeat({ host: null, reachability: "unreachable" }, "burning")).toMatchObject({
      tier: "normal",
      status: "unavailable",
    });
    expect(fleetMachineHeat({ host: null, reachability: "unsupported" })).toMatchObject({
      tier: "normal",
      status: "unavailable",
    });
    expect(fleetMachineHeat(undefined)).toMatchObject({
      tier: "normal",
      status: "none",
      summary: "No metrics",
    });
  });
});

describe("fleetMachineHeatEqual", () => {
  it("sees a changed reading even when the summary text does not change", () => {
    const entry = (quota: number): HostStatusEntry => ({
      host: null,
      reachability: "ok",
      metrics: metrics({ quotas: [quotaOf(quota)] }),
    });
    const low = fleetMachineHeat(entry(10));
    const higher = fleetMachineHeat(entry(60));
    expect(higher.summary).toBe(low.summary);
    expect(fleetMachineHeatEqual(low, higher)).toBe(false);
    expect(fleetMachineHeatEqual(low, fleetMachineHeat(entry(10)))).toBe(true);
  });
});

describe("matchFleetHostEntries", () => {
  const primary = EnvironmentId.make("primary");
  const studio = EnvironmentId.make("studio");
  const mini = EnvironmentId.make("mini");
  const box = EnvironmentId.make("box");
  const at = (host: string | null, cpu: number): HostStatusEntry => ({
    host,
    reachability: "ok",
    metrics: metrics({ cpuUtilization: cpu }),
  });
  const machine = (
    id: string,
    label: string,
    environmentId: EnvironmentId | null,
    sshHost: { via: EnvironmentId; alias: string } | null = null,
  ) => ({ id, label, environmentId, sshHost });

  it("prefers an environment's own answer, then its SSH alias, then a unique label", () => {
    const primaryReport = [at(null, 0.1), at("studio-ssh", 0.2), at("mini", 0.3), at("lab", 0.4)];
    const studioReport = [at(null, 0.9)];
    const matched = matchFleetHostEntries({
      machines: [
        machine("p", "This Mac", primary),
        machine("s", "studio", studio),
        machine("m", "mini", mini),
        machine("b", "box", box),
        machine("lab", "lab", null, { via: primary, alias: "lab" }),
        machine("gone", "gone", null, { via: primary, alias: "gone" }),
      ],
      sshAliases: new Map([
        [studio, ["studio-ssh"]],
        [mini, []],
        [box, []],
      ]),
      reports: new Map([
        [primary, primaryReport],
        [studio, studioReport],
      ]),
      primaryEnvironmentId: primary,
    });
    expect(matched.get("p")).toBe(primaryReport[0]);
    // Its own answer beats the primary's relay through studio-ssh.
    expect(matched.get("s")).toBe(studioReport[0]);
    expect(matched.get("m")).toBe(primaryReport[2]);
    expect(matched.has("b")).toBe(false);
    expect(matched.get("lab")).toBe(primaryReport[3]);
    expect(matched.has("gone")).toBe(false);
  });

  it("falls back to the SSH alias when the environment has no answer of its own", () => {
    const primaryReport = [at(null, 0.1), at("studio-ssh", 0.2)];
    const matched = matchFleetHostEntries({
      machines: [machine("s", "studio", studio)],
      sshAliases: new Map([[studio, ["studio-ssh"]]]),
      reports: new Map([[primary, primaryReport]]),
      primaryEnvironmentId: primary,
    });
    expect(matched.get("s")).toBe(primaryReport[1]);
  });

  it("does not match a label to an alias another environment connects through", () => {
    const matched = matchFleetHostEntries({
      machines: [machine("m", "studio-ssh", mini), machine("s", "studio", studio)],
      sshAliases: new Map([
        [mini, []],
        [studio, ["studio-ssh"]],
      ]),
      reports: new Map([[primary, [at(null, 0.1), at("studio-ssh", 0.2)]]]),
      primaryEnvironmentId: primary,
    });
    expect(matched.has("m")).toBe(false);
    expect(matched.has("s")).toBe(true);
  });

  it("does not match a label two machines share", () => {
    const other = EnvironmentId.make("other-mini");
    const matched = matchFleetHostEntries({
      machines: [machine("m", "mini", mini), machine("o", "Mini", other)],
      sshAliases: new Map([
        [mini, []],
        [other, []],
      ]),
      reports: new Map([[primary, [at(null, 0.1), at("mini", 0.9)]]]),
      primaryEnvironmentId: primary,
    });
    expect(matched.size).toBe(0);
  });

  it("never gives the primary's own entry to another machine", () => {
    const matched = matchFleetHostEntries({
      machines: [machine("m", "mini", mini)],
      sshAliases: new Map([[mini, []]]),
      reports: new Map([[primary, [at(null, 0.1)]]]),
      primaryEnvironmentId: primary,
    });
    expect(matched.size).toBe(0);
  });
});

describe("fleetHostStatusNeeded", () => {
  const primary = EnvironmentId.make("a");
  const b = EnvironmentId.make("b");
  const ok = (host: string | null): HostStatusEntry => ({
    host,
    reachability: "ok",
    metrics: metrics(),
  });
  const needed = (overrides: Partial<Parameters<typeof fleetHostStatusNeeded>[0]>) =>
    fleetHostStatusNeeded({
      environmentId: b,
      sshAliases: ["b-ssh"],
      primaryEnvironmentId: primary,
      primaryHosts: [ok(null), ok("b-ssh")],
      dispatchers: new Set(),
      ...overrides,
    });

  it("skips an environment the primary already reaches over SSH", () => {
    expect(needed({})).toBe(false);
  });

  it("reads it when the primary does not cover it", () => {
    expect(needed({ primaryHosts: [ok(null)] })).toBe(true);
    expect(
      needed({ primaryHosts: [ok(null), { host: "b-ssh", reachability: "unreachable" }] }),
    ).toBe(true);
  });

  it("reads a covered environment whose SSH or cloud hosts are in the fleet (A to B to C)", () => {
    expect(needed({ dispatchers: new Set([b]) })).toBe(true);
  });

  it("reads an environment the primary cannot cover without waiting for the primary", () => {
    expect(needed({ primaryHosts: null, sshAliases: [] })).toBe(true);
    expect(needed({ primaryHosts: null })).toBe(false);
    expect(needed({ primaryHosts: null, dispatchers: new Set([b]) })).toBe(true);
  });

  it("always reads the primary", () => {
    expect(needed({ environmentId: primary })).toBe(true);
  });
});
