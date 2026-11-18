import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  UsageLimitSourceId,
  type ServerProvider,
} from "@goat/contracts";
import { expect, it } from "vite-plus/test";
import {
  collectLimitAccounts,
  collectProviderUsageLimits,
  resetCreditChoices,
} from "./usageLimits.ts";

const now = Date.parse("2026-09-03T12:00:00.000Z");
const checkedAt = "2026-09-03T11:00:00.000Z";
const window = {
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent: 40,
  windowDurationMins: 300,
  resetsAt: "2026-09-03T14:00:00.000Z",
} as const;
const claude = ProviderDriverKind.make("claudeAgent");
const source = {
  id: UsageLimitSourceId.make("hub"),
  kind: "cliproxy" as const,
  label: "hub",
  checkedAt,
};
const laptop = { entry: { target: { label: "Laptop" } } };
function provider(overrides: Partial<ServerProvider>): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}
it("keeps direct reset options and their target even when the hub report is newer", () => {
  const native = provider({
    driver: claude,
    instanceId: ProviderInstanceId.make("claude"),
    auth: { status: "authenticated", email: "same@example.com" },
    usageLimits: {
      checkedAt: "2026-09-03T11:30:00.000Z",
      windows: [{ ...window, usedPercent: 40 }],
      resetCredits: {
        availableCount: 3,
        nextCreditId: "native-credit",
        options: [
          {
            creditId: "weekly",
            label: "Weekly",
            description: "Weekly window",
            availableCount: 1,
          },
          { creditId: "fable", label: "Fable", description: "Fable window", availableCount: 1 },
        ],
      },
    },
  });
  const input = new Map([
    [
      EnvironmentId.make("env-a"),
      {
        ...laptop,
        serverConfig: {
          providers: [native],
          usageLimitSources: [
            {
              ...source,
              accounts: [
                {
                  id: "claude-same@example.com.json",
                  driver: claude,
                  email: "same@example.com",
                  usageLimits: {
                    checkedAt,
                    windows: [{ ...window, usedPercent: 55 }],
                    resetCredits: { availableCount: 2, nextCreditId: "hub-credit" },
                  },
                },
              ],
            },
          ],
        },
      },
    ],
  ]);
  const [account] = collectLimitAccounts(input);
  expect(account?.redeem).toEqual({
    environmentId: "env-a",
    input: { instanceId: "claude" },
  });
  expect(account?.limits.resetCredits?.availableCount).toBe(3);
  expect(
    resetCreditChoices(account!.limits.resetCredits!, account!.redeem!.input, now)[1]?.input,
  ).toEqual({ instanceId: "claude", creditId: "fable" });
  const hubNewer = structuredClone(input);
  const hub = hubNewer.get(EnvironmentId.make("env-a"))!.serverConfig.usageLimitSources[0]!
    .accounts[0]!;
  hub.usageLimits.checkedAt = "2026-09-03T12:00:00.000Z";
  const [freshHub] = collectLimitAccounts(hubNewer);
  expect(freshHub?.limits.resetCredits).toEqual(native.usageLimits?.resetCredits);
  expect(freshHub?.redeem?.input).toEqual({ instanceId: "claude" });
});

it("keeps direct grant choices in the composer when a newer hub has a credit", () => {
  const native = provider({
    driver: claude,
    instanceId: ProviderInstanceId.make("claude"),
    auth: { status: "authenticated", email: "same@example.com" },
    usageLimits: {
      checkedAt,
      windows: [window],
      resetCredits: {
        availableCount: 1,
        options: [
          { creditId: "weekly", label: "Weekly", description: "Weekly window", availableCount: 1 },
        ],
      },
    },
  });
  const hub = [
    {
      ...source,
      accounts: [
        {
          id: "same.json",
          driver: claude,
          email: "same@example.com",
          usageLimits: {
            checkedAt: "2026-09-03T11:30:00.000Z",
            windows: [window],
            resetCredits: { availableCount: 2, nextCreditId: "hub-credit" },
          },
        },
      ],
    },
  ];
  const report = collectProviderUsageLimits(native.instanceId, [native], hub, now);
  expect(report?.accounts[0]?.limits.resetCredits).toEqual(native.usageLimits?.resetCredits);
  expect(report?.accounts[0]?.resetCreditInput).toEqual({ instanceId: "claude" });
});

it("does not offer redemption when the chosen hub credit has no id", () => {
  const limits = { checkedAt, windows: [window] };
  const selected = provider({
    usageLimits: limits,
    auth: { status: "authenticated", email: "same@example.com" },
  });
  const hub = [
    {
      ...source,
      accounts: [
        {
          id: "duplicate",
          driver: selected.driver,
          email: "same@example.com",
          usageLimits: { ...limits, resetCredits: { availableCount: 2 } },
        },
      ],
    },
  ];
  const report = collectProviderUsageLimits(selected.instanceId, [selected], hub, now);
  expect(report?.accounts[0]?.limits.resetCredits?.availableCount).toBe(2);
  expect(report?.accounts[0]?.redeemable).toBe(false);
  expect(report?.accounts[0]?.resetCreditInput).toBeUndefined();
});

it("a fresher direct report at zero beats an older direct report with options in Usage", () => {
  const older = provider({
    instanceId: ProviderInstanceId.make("old"),
    driver: claude,
    auth: { status: "authenticated", email: "same@example.com" },
    usageLimits: {
      checkedAt,
      windows: [window],
      resetCredits: {
        availableCount: 1,
        options: [
          { creditId: "weekly", label: "Weekly", description: "Weekly", availableCount: 1 },
        ],
      },
    },
  });
  const newer = provider({
    instanceId: ProviderInstanceId.make("new"),
    driver: claude,
    auth: { status: "authenticated", email: "same@example.com" },
    usageLimits: {
      checkedAt: "2026-09-03T11:30:00.000Z",
      windows: [window],
      resetCredits: { availableCount: 0 },
    },
  });
  for (const providers of [
    [older, newer],
    [newer, older],
  ]) {
    const [account] = collectLimitAccounts(
      new Map([[EnvironmentId.make("env-a"), { ...laptop, serverConfig: { providers } }]]),
    );
    expect(account?.limits.resetCredits).toEqual({ availableCount: 0 });
    expect(account?.redeem?.input).toEqual({ instanceId: "new" });
  }
});

it("a fresher direct report at zero beats an older direct report with options in the composer", () => {
  const older = provider({
    instanceId: ProviderInstanceId.make("old"),
    driver: claude,
    auth: { status: "authenticated", email: "same@example.com" },
    usageLimits: {
      checkedAt,
      windows: [window],
      resetCredits: {
        availableCount: 1,
        options: [
          { creditId: "weekly", label: "Weekly", description: "Weekly", availableCount: 1 },
        ],
      },
    },
  });
  const newer = provider({
    instanceId: ProviderInstanceId.make("new"),
    driver: claude,
    auth: { status: "authenticated", email: "same@example.com" },
    usageLimits: {
      checkedAt: "2026-09-03T11:30:00.000Z",
      windows: [window],
      resetCredits: { availableCount: 0 },
    },
  });
  for (const providers of [
    [older, newer],
    [newer, older],
  ]) {
    const report = collectProviderUsageLimits(newer.instanceId, providers, [], now);
    expect(report?.accounts[0]?.limits.resetCredits).toEqual({ availableCount: 0 });
    expect(report?.accounts[0]?.resetCreditInput).toEqual({ instanceId: "new" });
  }
});
