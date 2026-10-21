import {
  ProviderDriverKind,
  ProviderInstanceId,
  type HostStatusQuota,
  type QuotaPool,
  type QuotaWindow,
} from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import { fleetQuota } from "./fleetQuota";
import { quotaRows, type FleetHostRow } from "./fleetTelemetry";

const AT = "2026-10-21T08:00:00.000Z";
const LATER = "2026-10-21T09:00:00.000Z";

function window(id: string, usedPercent?: number): QuotaWindow {
  return {
    id,
    kind: id === "5h" ? "burst_5h" : "weekly",
    label: id,
    source: "measured",
    observedAt: AT,
    ...(usedPercent === undefined ? {} : { usedPercent }),
  };
}

function pool(homeId = "home", overrides: Partial<QuotaPool> = {}): QuotaPool {
  return {
    schema: "ocx.quota-pool/1",
    producer: { version: "3.0.0", role: "hub", homeId },
    generatedAt: AT,
    providers: [
      {
        provider: "openai",
        pooled: { windows: [window("5h", 21), window("weekly", 43)] },
        accounts: [
          {
            provider: "openai",
            accountRef: "account-a",
            label: "Account A",
            state: "available",
            windows: [window("5h", 35)],
          },
        ],
      },
    ],
    ...overrides,
  };
}

function quota(
  id: string,
  usedPercent = 97,
  reference?: { homeId: string; provider: string },
  driver = "codex",
): HostStatusQuota {
  return {
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make(driver),
    displayName: id,
    fromCache: false,
    limits: {
      checkedAt: AT,
      windows: [{ id: "local", kind: "weekly", label: "Local weekly", usedPercent }],
      ...(reference === undefined ? {} : { quotaPool: reference }),
    },
  };
}

function row(
  key: string,
  quotas: ReadonlyArray<HostStatusQuota> = [],
  quotaPool?: QuotaPool,
): FleetHostRow {
  return {
    key,
    label: key === "home" ? "Hub workstation" : key,
    machineId: key,
    sourceKey: key,
    tone: "ok",
    entry: {
      host: key,
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
        quotas,
        ...(quotaPool === undefined ? {} : { quotaPool }),
      },
    },
  };
}

const reference = { homeId: "home", provider: "openai" };

describe("Fleet OpenCodex quota", () => {
  it.each([
    {
      scenario: "link Home label",
      inventory: { link: { homeLabel: "Link hub" }, runtime: { homeName: "Runtime hub" } },
      producerName: "Producer hub",
      expected: "Link hub",
    },
    {
      scenario: "status Home name",
      inventory: { runtime: { homeName: "Runtime hub" } },
      producerName: "Producer hub",
      expected: "Runtime hub",
    },
    {
      scenario: "producer display name",
      inventory: {},
      producerName: "Producer hub",
      expected: "Producer hub",
    },
    {
      scenario: "blank inventory name",
      inventory: { link: { homeLabel: "  " }, runtime: { homeName: "  Runtime hub  " } },
      producerName: "Producer hub",
      expected: "Runtime hub",
    },
    {
      scenario: "no display metadata",
      inventory: undefined,
      producerName: undefined,
      expected: null,
    },
    {
      scenario: "raw IDs in display fields",
      inventory: { link: { homeLabel: "opaque-home-id" }, runtime: { homeName: "opaque-home-id" } },
      producerName: "opaque-home-id",
      expected: null,
    },
    {
      scenario: "invalid or blank names",
      inventory: { link: { homeLabel: 42 }, runtime: null },
      producerName: " ",
      expected: null,
    },
  ])(
    "uses $scenario without showing an opaque Home ID",
    ({ inventory, producerName, expected }) => {
      const snapshot = pool("opaque-home-id", {
        producer: {
          version: "3.0.0",
          role: "hub",
          homeId: "opaque-home-id",
          ...(producerName === undefined ? {} : { displayName: producerName }),
        },
      });
      const child = row("child-a", [], snapshot);
      const opencodex =
        inventory === undefined
          ? undefined
          : {
              installed: true,
              binaries: [],
              ownership: "adopted" as const,
              service: { available: true },
              link: {
                role: "child" as const,
                available: true,
                links: [],
                childSettingsApplied: null,
                ...inventory.link,
              },
              runtime: {
                role: "client" as const,
                port: 10100,
                healthy: true,
                ready: true,
                ...inventory.runtime,
              },
            };
      const namedChild = {
        ...child,
        entry: { ...child.entry!, metrics: { ...child.entry!.metrics!, opencodex } },
      };
      for (const rows of [
        [namedChild, row("child-b", [], snapshot)],
        [row("child-b", [], snapshot), namedChild],
      ]) {
        const result = fleetQuota(rows);
        expect(result.quotas[0]!.host).toBe(expected);
        expect(result.quotas[0]!.detail?.split("\n")[0]).toBe(
          "OpenCodex pool" + (expected === null ? "" : ` · ${expected}`),
        );
        expect(result.quotas[0]!.detail).not.toContain("opaque-home-id");
        expect([...result.viaHub.values()]).toEqual([expected, expected]);
      }
    },
  );

  it("renders one Home pool across devices and deduplicates accountRef within it", () => {
    const base = pool();
    const provider = base.providers[0]!;
    const snapshot = pool("home", {
      producer: { ...base.producer, displayName: "Hub workstation" },
      providers: [{ ...provider, accounts: [...provider.accounts, ...provider.accounts] }],
    });
    const result = fleetQuota([
      row("home", [quota("hub-codex", 97, reference)], snapshot),
      row("child-a", [quota("child-codex", 98, reference)], snapshot),
      row("child-b", [quota("other-codex", 99, reference)], snapshot),
    ]);
    expect(result.quotas).toHaveLength(1);
    expect(result.quotas[0]).toMatchObject({
      label: "OpenCodex pool",
      host: "Hub workstation",
      peak: 43,
      hidden: 1,
    });
    expect(result.quotas[0]!.windows.map((w) => w.usedPercent)).toEqual([43, 21]);
    expect(result.quotas[0]!.detail?.match(/Account A/g)).toHaveLength(1);
    expect([...result.viaHub.values()]).toEqual([
      "Hub workstation",
      "Hub workstation",
      "Hub workstation",
    ]);
  });

  it("keeps independent sign-ins, including another instance of the same provider on a Child", () => {
    const result = fleetQuota([
      row(
        "child",
        [
          quota("routed", 99, reference),
          quota("own-codex", 76),
          quota("own-claude", 65, undefined, "claudeAgent"),
        ],
        pool(),
      ),
      row("standalone", [quota("standalone-codex", 54)]),
    ]);
    expect(result.quotas.map((q) => [q.label, q.peak])).toEqual([
      ["OpenCodex pool", 43],
      ["own-codex", 76],
      ["own-claude", 65],
      ["standalone-codex", 54],
    ]);
    expect(result.viaHub.has("standalone")).toBe(false);
  });

  it("uses host pool evidence when instance references are not yet available", () => {
    const result = fleetQuota([
      row(
        "child",
        [quota("old-local-reading", 99), quota("own-claude", 64, undefined, "claudeAgent")],
        pool(),
      ),
    ]);
    expect(result.quotas.map((q) => q.label)).toEqual(["OpenCodex pool", "own-claude"]);
    expect(result.viaHub.get("child")).toBeNull();
  });

  it("uses the latest Home snapshot and does not resurrect windows from older devices", () => {
    const newest = pool("home", {
      generatedAt: LATER,
      providers: [
        {
          provider: "openai",
          pooled: { windows: [window("weekly", 52), window("5h")] },
          accounts: [],
        },
      ],
    });
    for (const rows of [
      [row("old", [], pool()), row("new", [], newest)],
      [row("new", [], newest), row("old", [], pool())],
    ]) {
      const result = fleetQuota(rows).quotas;
      expect(result).toHaveLength(1);
      expect(result[0]!.windows.map((w) => [w.id, w.usedPercent])).toEqual([
        [JSON.stringify(["openai", "weekly"]), 52],
      ]);
    }
  });

  it("does not merge different Homes that use the same provider or accountRef", () => {
    const result = fleetQuota([row("a", [], pool("home-a")), row("b", [], pool("home-b"))]);
    expect(new Set(result.quotas.map((q) => q.key)).size).toBe(2);
    expect(result.quotas.map((q) => q.host)).toEqual([null, null]);
  });

  it("groups multiple providers and account windows inside the same Home row with +N detail", () => {
    const base = pool();
    const anthropic = {
      provider: "anthropic",
      pooled: { windows: [window("5h", 68), window("weekly", 73)] },
      accounts: [
        {
          provider: "anthropic",
          accountRef: "account-a",
          label: "Claude A",
          state: "available" as const,
          windows: [{ ...window("opus", 81), scopeModel: "opus", source: "header" as const }],
        },
      ],
    };
    const result = fleetQuota([
      row("child", [], pool("home", { providers: [...base.providers, anthropic] })),
    ]).quotas;
    expect(result).toHaveLength(1);
    expect(result[0]!.windows.map((w) => w.label)).toEqual(["anthropic weekly", "anthropic 5h"]);
    expect(result[0]!.hidden).toBe(4);
    expect(result[0]!.detail).toContain("2 more windows · 2 accounts");
    expect(result[0]!.detail).toContain("opus (opus): 81% (header)");
    expect(result[0]!.detail).toContain("openai: 5h: 21% (measured)");
  });

  it("omits unknown percentages, preserves a measured zero, and never derives pool math from accounts", () => {
    const snapshot = pool("home", {
      providers: [
        { ...pool().providers[0]!, pooled: { windows: [window("5h"), window("weekly", 0)] } },
      ],
    });
    const measured = fleetQuota([row("child", [], snapshot)]).quotas[0]!;
    expect(measured.windows.map((w) => w.usedPercent)).toEqual([0]);
    expect(measured.peak).toBe(0);
    const unknown = fleetQuota([
      row(
        "child",
        [],
        pool("home", {
          providers: [{ ...snapshot.providers[0]!, pooled: { windows: [window("5h")] } }],
        }),
      ),
    ]).quotas[0]!;
    expect(unknown.windows).toEqual([]);
    expect(unknown.peak).toBeNull();
    expect(unknown.detail).toContain("Quota unknown");
    expect(unknown.detail).toContain("Account A (available): 5h: 35%");
  });

  it("deduplicates projected references even when the full host pool is unavailable", () => {
    const result = fleetQuota([
      row("a", [quota("codex-a", 34, reference)]),
      row("b", [quota("codex-b", 34, reference)]),
    ]);
    expect(result.quotas).toHaveLength(1);
    expect(result.quotas[0]).toMatchObject({ label: "OpenCodex pool", peak: 34 });
  });

  it("retains existing local-account behavior when a 404 or older OpenCodex omits pool data", () => {
    const rows = [row("a", [quota("codex", 58)]), row("b", [quota("codex", 69)])];
    const result = fleetQuota(rows);
    expect(result.viaHub.size).toBe(0);
    expect(result.quotas).toEqual(quotaRows(rows).map((q) => ({ ...q, hidden: 0 })));
  });
});
