import type { HostStatusEntry, HubParityResult, OpenCodexInventorySnapshot } from "@goat/contracts";

export function opencodex(
  role: "home" | "child",
  linked: ReadonlyArray<string> = ["macmini-ts", "lidge-ts"],
): OpenCodexInventorySnapshot {
  return {
    installed: true,
    binaries: [],
    ownership: "adopted",
    service: { available: false },
    runtime: {
      version: role === "home" ? "2.89.0" : "2.83.0",
      role: role === "home" ? "standalone" : "client",
      port: 10100,
      healthy: true,
      ready: true,
    },
    link: {
      role,
      available: true,
      links:
        role === "home"
          ? linked.map((alias, index) => ({
              id: `lnk_${index}`,
              alias,
              tunnelPort: 42000 + index,
              state: "connected" as const,
            }))
          : [],
      childSettingsApplied: role === "child" ? false : null,
      homeName: "jun-mbp",
    },
  };
}

export function host(
  name: string | null,
  parity?: HubParityResult,
  linked?: ReadonlyArray<string>,
): HostStatusEntry {
  return {
    host: name,
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
      opencodex: {
        ...opencodex(name === null ? "home" : "child", linked),
        // The Home allows this Child to use its own providers (OCX-11).
        ...(name === "macmini-ts" ? { fallback: { source: "home", localFallback: true } } : {}),
      },
    },
    ...(parity ? { parity } : {}),
  };
}
