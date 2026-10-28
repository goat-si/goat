import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import { collectProviderUsageLimits } from "./usageLimits.ts";

const now = Date.parse("2026-09-03T12:00:00.000Z");
const window = {
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent: 40,
  windowDurationMins: 300,
  resetsAt: "2026-09-03T14:00:00.000Z",
} as const;

function provider(overrides: Partial<ServerProvider>): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-03T11:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

describe("OpenCodex-routed /usage-limits rows", () => {
  it("keeps a routed instance whose pool is unavailable apart from a direct instance on the same login", () => {
    const login = { status: "authenticated" as const, email: "same@example.com" };
    const direct = provider({
      instanceId: ProviderInstanceId.make("direct"),
      auth: login,
      usageLimits: {
        checkedAt: "2026-09-03T11:00:00.000Z",
        windows: [window],
        resetCredits: { availableCount: 1, nextCreditId: "credit" },
      },
    });
    const routed = provider({
      instanceId: ProviderInstanceId.make("codex"),
      auth: login,
      usageLimits: {
        checkedAt: "2026-09-03T11:30:00.000Z",
        windows: [],
        unavailable: {
          reason: "probeFailed",
          message: "OpenCodex pool unavailable (OpenCodex 2.86.0).",
        },
        quotaPoolRoute: { provider: "openai" },
      },
    });
    const report = collectProviderUsageLimits(routed.instanceId, [direct, routed], [], now);
    expect(report?.accounts.map((account) => account.id)).toEqual(["direct", "codex"]);
    expect(report?.accounts[1]).toMatchObject({
      sourceLabel: "via OpenCodex",
      limits: { unavailable: { message: "OpenCodex pool unavailable (OpenCodex 2.86.0)." } },
    });
    expect(report?.accounts[1]?.resetCreditInput).toBeUndefined();
    expect(report?.accounts[1]?.email).toBeUndefined();
    expect(report?.accounts[0]?.resetCreditInput).toEqual({ instanceId: "direct" });
  });
});
