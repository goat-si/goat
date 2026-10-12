import {
  ProviderDriverKind,
  ProviderInstanceId,
  type HostStatusEntry,
  type HostStatusMetrics,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  formatLoadAverage,
  hostCards,
  hostMeters,
  NOT_AVAILABLE,
  platformLabel,
} from "./hostStatusView";

const now = Date.parse("2026-10-12T16:00:00.000Z");
const GiB = 1_073_741_824;

const linux: HostStatusMetrics = {
  sampledAt: now - 1_000,
  cpuUtilization: 0.123,
  cpuCount: 8,
  availableMemoryBytes: 4 * GiB,
  totalMemoryBytes: 16 * GiB,
  loadAvg: { oneMinute: 1.2, fiveMinutes: 0.9, fifteenMinutes: 0.7 },
  disk: { path: "/", availableBytes: 100 * GiB, totalBytes: 400 * GiB },
  platform: "linux",
  threads: { running: 2, waiting: 1, queued: 0 },
  quotas: [
    {
      instanceId: ProviderInstanceId.make("codex"),
      driver: ProviderDriverKind.make("codex"),
      fromCache: true,
      limits: {
        checkedAt: "2026-10-12T15:59:00.000Z",
        windows: [{ id: "primary", kind: "session", label: "5h", usedPercent: 40 }],
      },
    },
  ],
};

/** What a Windows host sends: no load average and, when statfs cannot answer, no disk. */
const windows: HostStatusMetrics = {
  ...linux,
  platform: "win32",
  loadAvg: null,
  disk: null,
  cpuUtilization: null,
  quotas: [],
};

describe("hostMeters", () => {
  it("reports CPU, memory, and disk as used shares with what is free", () => {
    expect(hostMeters(linux)).toEqual([
      { label: "CPU", usedPercent: 12, detail: "12% of 8 cores" },
      { label: "Memory", usedPercent: 75, detail: "4.00 GB free of 16.0 GB" },
      { label: "Disk", usedPercent: 75, detail: "100 GB free of 400 GB" },
    ]);
  });

  it("says not available for a Windows host's missing disk and an unsampled CPU", () => {
    const [cpu, , disk] = hostMeters(windows);
    expect(cpu).toEqual({ label: "CPU", usedPercent: null, detail: "8 cores" });
    expect(disk).toEqual({ label: "Disk", usedPercent: null, detail: NOT_AVAILABLE });
  });

  it("does not divide by an empty total", () => {
    const [, memory, disk] = hostMeters({
      ...linux,
      availableMemoryBytes: 0,
      totalMemoryBytes: 0,
      disk: { path: "C:\\", availableBytes: 0, totalBytes: 0 },
    });
    expect(memory?.usedPercent).toBeNull();
    expect(memory?.detail).toBe(NOT_AVAILABLE);
    expect(disk?.usedPercent).toBeNull();
    expect(disk?.detail).toBe(NOT_AVAILABLE);
  });
});

describe("formatLoadAverage", () => {
  it("prints 1, 5, and 15 minute load, and null where the OS has none", () => {
    expect(formatLoadAverage(linux.loadAvg)).toBe("1.20 · 0.90 · 0.70");
    expect(formatLoadAverage(null)).toBeNull();
  });
});

describe("platformLabel", () => {
  it("names common platforms and passes others through", () => {
    expect(platformLabel("darwin")).toBe("macOS");
    expect(platformLabel("win32")).toBe("Windows");
    expect(platformLabel("aix")).toBe("aix");
    expect(platformLabel(undefined)).toBeNull();
  });
});

describe("hostCards", () => {
  const hosts: ReadonlyArray<HostStatusEntry> = [
    { host: null, reachability: "ok", metrics: linux },
    { host: "win-box", reachability: "ok", metrics: windows },
    {
      host: "build-box",
      reachability: "unreachable",
      lastKnown: true,
      message: "build-box is unavailable: connection timed out",
      metrics: { ...linux, sampledAt: now - 4 * 60_000 },
    },
    { host: "fresh-box", reachability: "unreachable", message: "No route to host" },
    {
      host: "old-mac",
      reachability: "unsupported",
      message: "GOAT on old-mac does not offer goat_host_status. Update GOAT on that machine.",
    },
  ];
  const cards = hostCards(hosts, now, "Studio");

  it("labels this machine and keeps the server's order", () => {
    expect(cards.map((card) => [card.label, card.local])).toEqual([
      ["Studio", true],
      ["win-box", false],
      ["build-box", false],
      ["fresh-box", false],
      ["old-mac", false],
    ]);
    expect(new Set(cards.map((card) => card.key)).size).toBe(cards.length);
  });

  it("tells reachable, last known with its age, unreachable, and unsupported apart", () => {
    expect(cards.map((card) => [card.tone, card.status])).toEqual([
      ["ok", "Reachable"],
      ["ok", "Reachable"],
      ["stale", "Last known 4m ago"],
      ["unavailable", "Unreachable"],
      ["unavailable", "Update GOAT to report status"],
    ]);
  });

  it("keeps a last-known sample's bars and message, and has none for hosts without a sample", () => {
    const [, , stale, fresh, old] = cards;
    expect(stale?.meters).toHaveLength(3);
    expect(stale?.message).toBe("build-box is unavailable: connection timed out");
    expect(fresh?.meters).toBeNull();
    expect(fresh?.threads).toBeNull();
    expect(fresh?.quotas).toEqual([]);
    expect(old?.meters).toBeNull();
    expect(old?.platform).toBeNull();
  });

  it("carries a Windows host's missing load average as null rather than zeros", () => {
    const win = cards[1];
    expect(win?.platform).toBe("Windows");
    expect(win?.loadAverage).toBeNull();
    expect(win?.threads).toEqual({ running: 2, waiting: 1, queued: 0 });
  });

  it("passes quota through for the usage-limit rows", () => {
    expect(cards[0]?.quotas.map((quota) => quota.instanceId)).toEqual(["codex"]);
  });
});
