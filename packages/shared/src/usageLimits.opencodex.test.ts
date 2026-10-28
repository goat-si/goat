import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  UsageLimitSourceId,
  type ServerProvider,
} from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  collectLimitAccounts,
  collectLimitPools,
  collectProviderUsageLimits,
} from "./usageLimits.ts";
import { collectOpenCodexPools } from "./usageLimitsOpenCodex.ts";

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

describe("OpenCodex pools in Usage", () => {
  const env = (id: string) => EnvironmentId.make(id);
  const weekly = (usedPercent: number) => ({
    ...window,
    id: "weekly",
    kind: "weekly" as const,
    label: "Weekly",
    usedPercent,
  });
  const routed = provider({
    auth: { status: "authenticated", email: "main@example.com" },
    usageLimits: {
      checkedAt: "2026-09-03T11:59:00.000Z",
      windows: [weekly(52)],
      quotaPool: { provider: "openai", homeId: "home-a", accounts: { available: 2, total: 3 } },
      quotaPoolRoute: { provider: "openai" },
      localAccount: {
        checkedAt: "2026-09-03T11:59:00.000Z",
        windows: [weekly(98)],
        resetCredits: { availableCount: 1, nextCreditId: "credit" },
        redeemable: true,
      },
    },
  });
  const source = (
    checkedAt: string,
    accounts: ReadonlyArray<readonly [string, number, "available" | "paused"]>,
    homeId?: string,
  ) => ({
    id: UsageLimitSourceId.make("opencodex"),
    kind: "opencodex" as const,
    label: "via OpenCodex Home home-a",
    checkedAt,
    ...(homeId === undefined ? {} : { homeId }),
    accounts: accounts.map(([ref, used, state]) => ({
      id: JSON.stringify([homeId ?? "legacy", "openai", ref]),
      driver: ProviderDriverKind.make("codex"),
      label: ref,
      state,
      usageLimits: { checkedAt, windows: [weekly(used)] },
    })),
  });
  const presentation = (
    label: string,
    providers: ServerProvider[],
    sources: ReturnType<typeof source>[],
  ) => ({
    entry: { target: { label } },
    serverConfig: { providers, usageLimitSources: sources },
  });
  const homeSnapshot = source(
    "2026-09-03T11:59:00.000Z",
    [
      ["main", 98, "available"],
      ["p61", 7, "available"],
      ["p32", 45, "paused"],
    ],
    "home-a",
  );

  it("counts each pool account once, never the pool total or the routed login, and leaves paused accounts out", () => {
    const accounts = collectLimitAccounts(
      new Map([[env("studio"), presentation("Studio", [routed], [homeSnapshot])]]),
    );
    const [codex] = collectLimitPools(accounts, now);
    expect(codex?.windows.map((item) => item.usedPercent)).toEqual([53]);
    expect(codex?.accounts).toHaveLength(4);
    const local = accounts.find((account) => account.email === "main@example.com");
    expect(local).toMatchObject({
      aggregated: false,
      redeem: { environmentId: "studio", input: { instanceId: "codex" } },
    });
    expect(local?.limits.resetCredits?.availableCount).toBe(1);
    expect(accounts.find((account) => account.displayName === "p32")).toMatchObject({
      aggregated: false,
      state: "paused",
    });
  });

  it("reports no aggregate for a window only excluded accounts read", () => {
    const paused = source("2026-09-03T11:59:00.000Z", [["p32", 45, "paused"]], "home-a");
    const [codex] = collectLimitPools(
      collectLimitAccounts(new Map([[env("studio"), presentation("Studio", [], [paused])]])),
      now,
    );
    expect(codex?.windows).toEqual([]);
    expect(codex?.accounts).toHaveLength(1);
  });

  it("takes membership from each Home's newest snapshot and keeps sources without a Home apart", () => {
    const older = source(
      "2026-09-03T11:00:00.000Z",
      [
        ["main", 98, "available"],
        ["gone", 1, "available"],
      ],
      "home-a",
    );
    const accounts = collectLimitAccounts(
      new Map([
        [
          env("child"),
          presentation(
            "Child",
            [],
            [older, source("2026-09-03T11:00:00.000Z", [["legacy-a", 10, "available"]])],
          ),
        ],
        [
          env("home"),
          presentation(
            "Home",
            [],
            [homeSnapshot, source("2026-09-03T11:30:00.000Z", [["legacy-b", 20, "available"]])],
          ),
        ],
      ]),
    );
    const names = accounts.map((account) => account.displayName).toSorted();
    expect(names).toEqual(["legacy-a", "legacy-b", "main", "p32", "p61"]);
  });

  it("lists one pool line per Home and provider with its inventory and blocks", () => {
    const blocked = {
      ...routed,
      usageLimits: {
        ...routed.usageLimits!,
        availability: [
          {
            id: "availability",
            label: "Availability",
            exhausted: true,
            resetsAt: "2026-09-04T00:00:00.000Z",
          },
        ],
      },
    };
    const lines = collectOpenCodexPools(
      new Map([
        [env("studio"), presentation("Studio", [blocked], [homeSnapshot])],
        [env("home"), presentation("Home", [blocked], [homeSnapshot])],
      ]),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      driver: "codex",
      homeId: "home-a",
      accounts: { available: 2, total: 3, excluded: 1 },
      windows: [{ id: "weekly", usedPercent: 52 }],
      availability: [{ id: "availability", exhausted: true }],
    });
  });

  it("shows the routed login's credits in the composer and redeems them only where the driver can", () => {
    const report = collectProviderUsageLimits(routed.instanceId, [routed], [homeSnapshot], now);
    const local = report?.accounts.find((account) => account.email === "main@example.com");
    expect(local?.limits.resetCredits?.availableCount).toBe(1);
    expect(local?.resetCreditInput).toEqual({ instanceId: "codex" });
    expect(
      report?.accounts.find((account) => account.id === "codex")?.limits.resetCredits,
    ).toBeUndefined();
    const goatRouted = {
      ...routed,
      usageLimits: {
        ...routed.usageLimits!,
        localAccount: { ...routed.usageLimits!.localAccount!, windows: [], redeemable: false },
      },
    };
    const windowless = collectProviderUsageLimits(
      routed.instanceId,
      [goatRouted],
      [],
      now,
    )?.accounts.find((account) => account.email === "main@example.com");
    expect(windowless).toMatchObject({
      redeemable: false,
      limits: { resetCredits: { availableCount: 1 } },
    });
    expect(windowless?.resetCreditInput).toBeUndefined();
  });
});

describe("routed login when the pool is unreadable", () => {
  it("counts the login as its own account so its quota and redeem target stay visible", () => {
    const unreadable = provider({
      auth: { status: "authenticated", email: "main@example.com" },
      usageLimits: {
        checkedAt: "2026-09-03T11:59:00.000Z",
        windows: [],
        unavailable: {
          reason: "probeFailed",
          message: "OpenCodex pool unavailable (OpenCodex 2.86.0): x.",
        },
        quotaPoolRoute: { provider: "openai", openCodexVersion: "2.86.0" },
        localAccount: {
          checkedAt: "2026-09-03T11:59:00.000Z",
          windows: [window],
          resetCredits: { availableCount: 1, nextCreditId: "credit" },
          redeemable: true,
        },
      },
    });
    const accounts = collectLimitAccounts(
      new Map([
        [
          EnvironmentId.make("studio"),
          { entry: { target: { label: "Studio" } }, serverConfig: { providers: [unreadable] } },
        ],
      ]),
    );
    const [codex] = collectLimitPools(accounts, now);
    expect(codex?.windows.map((item) => item.usedPercent)).toEqual([40]);
    expect(accounts[0]?.redeem).toEqual({
      environmentId: "studio",
      input: { instanceId: "codex" },
    });
  });
});
