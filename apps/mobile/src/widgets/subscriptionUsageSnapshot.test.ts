import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  UsageLimitSourceId,
  type ServerProvider,
} from "@goat/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  buildSubscriptionUsageSnapshot,
  createWidgetRefresher,
  WIDGET_REFRESH_INTERVAL,
} from "./subscriptionUsageSnapshot";

const checkedAt = "2026-09-05T12:00:00.000Z";
const now = Date.parse(checkedAt);
const window = {
  id: "session",
  kind: "session",
  label: "5 hours",
  usedPercent: 40,
  resetsAt: "2026-09-05T12:10:00.000Z",
} as const;
const limits = { checkedAt, windows: [window] };
const deepLink = "goat-dev://settings/usage?tab=limits";
function provider(overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated", email: "private@example.com" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: limits,
    ...overrides,
  };
}
function presentations(providers: readonly ServerProvider[] = [provider()]) {
  return new Map([
    [
      EnvironmentId.make("env"),
      { entry: { target: { label: "Remote" } }, serverConfig: { providers } },
    ],
  ]);
}

describe("subscription widget snapshots", () => {
  it("uses provider data and its observation time without exposing account emails", () => {
    const snapshot = buildSubscriptionUsageSnapshot(
      presentations([provider({ displayName: "private@example.com" })]),
      deepLink,
    );
    expect(snapshot.checkedAt).toBe(now);
    expect(snapshot.providers[0]).toMatchObject({
      name: "Codex",
      windows: [{ remaining: 60 }],
      expiresAt: now + 10 * 60_000,
    });
    expect(snapshot.url).toBe(deepLink);
    expect(JSON.stringify(snapshot)).not.toContain("private@example.com");
  });
  it("uses upstream deduplication for a native account also present in a proxy hub", () => {
    const input = new Map([
      [
        EnvironmentId.make("env"),
        {
          entry: { target: { label: "Remote" } },
          serverConfig: {
            providers: [provider()],
            usageLimitSources: [
              {
                id: UsageLimitSourceId.make("hub"),
                kind: "cliproxy" as const,
                label: "Hub",
                checkedAt,
                accounts: [
                  {
                    id: "account",
                    driver: ProviderDriverKind.make("codex"),
                    email: " PRIVATE@example.com ",
                    usageLimits: limits,
                  },
                ],
              },
            ],
          },
        },
      ],
    ]);
    expect(buildSubscriptionUsageSnapshot(input, deepLink).providers[0]?.detail).toBe(
      "Subscription remaining",
    );
    input.get(EnvironmentId.make("env"))!.serverConfig.providers = [];
    const snapshot = buildSubscriptionUsageSnapshot(input, deepLink);
    expect(snapshot.providers[0]?.name).toBe("Codex");
    expect(JSON.stringify(snapshot)).not.toContain("example.com");
  });
  it("bounds OS storage and puts the most constrained windows first", () => {
    const windows = Array.from({ length: 20 }, (_, index) => ({
      ...window,
      id: `${index}`,
      usedPercent: index * 5,
    }));
    const snapshot = buildSubscriptionUsageSnapshot(
      presentations([provider({ usageLimits: { checkedAt, windows } })]),
      deepLink,
    );
    expect(snapshot.providers[0]?.windows).toHaveLength(6);
    expect(snapshot.providers[0]?.totalWindows).toBe(20);
    expect(snapshot.providers[0]?.windows[0]?.remaining).toBe(5);
  });
  it("uses the freshest copy of an account across environments before pooling", () => {
    const input = presentations();
    input.set(EnvironmentId.make("other"), {
      entry: { target: { label: "Other" } },
      serverConfig: {
        providers: [
          provider({
            usageLimits: {
              checkedAt: new Date(now + 60_000).toISOString(),
              windows: [{ ...window, usedPercent: 80 }],
            },
          }),
        ],
      },
    });
    const snapshot = buildSubscriptionUsageSnapshot(input, deepLink);
    expect(snapshot.providers[0]?.detail).toBe("Subscription remaining");
    expect(snapshot.providers[0]?.windows[0]?.remaining).toBe(20);
  });
});

describe("widget refresh probes", () => {
  it("does not overlap a slow probe even after the refresh interval", async () => {
    let finish!: () => void;
    const probe = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const refresh = createWidgetRefresher(probe);
    const first = refresh(["one", "one"], now);
    await refresh(["one"], now + WIDGET_REFRESH_INTERVAL);
    expect(probe).toHaveBeenCalledTimes(1);
    finish();
    await first;
  });
});

describe("subscription widget with an OpenCodex pool", () => {
  it("takes freshness from counted accounts, not a paused one", () => {
    const old = new Date(now - 60 * 60_000).toISOString();
    const input = new Map([
      [
        EnvironmentId.make("env"),
        {
          entry: { target: { label: "Remote" } },
          serverConfig: {
            providers: [],
            usageLimitSources: [
              {
                id: UsageLimitSourceId.make("opencodex"),
                kind: "opencodex" as const,
                label: "via OpenCodex Home home-a",
                checkedAt,
                homeId: "home-a",
                accounts: [
                  {
                    id: "a",
                    driver: ProviderDriverKind.make("codex"),
                    state: "available" as const,
                    usageLimits: limits,
                  },
                  {
                    id: "b",
                    driver: ProviderDriverKind.make("codex"),
                    state: "paused" as const,
                    usageLimits: { checkedAt: old, windows: [{ ...window, usedPercent: 90 }] },
                  },
                ],
              },
            ],
          },
        },
      ],
    ]);
    const snapshot = buildSubscriptionUsageSnapshot(input, deepLink);
    expect(snapshot.checkedAt).toBe(now);
    expect(snapshot.providers[0]?.windows[0]?.remaining).toBe(60);
  });
});

describe("subscription widget freshness", () => {
  it("expires from when quota was observed, not when the pool snapshot was assembled", () => {
    const observed = new Date(now - 60 * 60_000).toISOString();
    const input = new Map([
      [
        EnvironmentId.make("env"),
        {
          entry: { target: { label: "Remote" } },
          serverConfig: {
            providers: [],
            usageLimitSources: [
              {
                id: UsageLimitSourceId.make("opencodex"),
                kind: "opencodex" as const,
                label: "via OpenCodex Home home-a",
                checkedAt,
                homeId: "home-a",
                accounts: [
                  {
                    id: "a",
                    driver: ProviderDriverKind.make("codex"),
                    state: "available" as const,
                    observedAt: observed,
                    usageLimits: limits,
                  },
                ],
              },
            ],
          },
        },
      ],
    ]);
    expect(buildSubscriptionUsageSnapshot(input, deepLink).checkedAt).toBe(Date.parse(observed));
  });
});
