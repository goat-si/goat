import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  UsageLimitSourceId,
  type ServerProvider,
} from "@goat/contracts";
import { expect, it } from "vite-plus/test";
import { collectLimitAccounts, resetCreditChoices } from "./usageLimits.ts";

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
it("redeems through the source of the fresher native credit report", () => {
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
  expect(freshHub?.limits.resetCredits?.nextCreditId).toBe("hub-credit");
  expect(freshHub?.redeem?.input).toEqual({
    sourceId: "hub",
    accountId: "claude-same@example.com.json",
    creditId: "hub-credit",
  });
});

it("uses the redeemable report's credits when a fresher routed login cannot redeem", () => {
  const direct = provider({
    instanceId: ProviderInstanceId.make("direct"),
    auth: { status: "authenticated", email: "same@example.com" },
    usageLimits: {
      checkedAt,
      windows: [window],
      resetCredits: {
        availableCount: 1,
        options: [
          { creditId: "direct-grant", label: "Direct", description: "Direct", availableCount: 1 },
        ],
      },
    },
  });
  const routed = provider({
    auth: { status: "authenticated", email: "same@example.com" },
    usageLimits: {
      checkedAt: "2026-09-03T11:30:00.000Z",
      windows: [],
      quotaPoolRoute: { provider: "openai" },
      localAccount: {
        checkedAt: "2026-09-03T11:30:00.000Z",
        windows: [window],
        resetCredits: { availableCount: 2, nextCreditId: "routed-grant" },
        redeemable: false,
      },
    },
  });
  for (const providers of [
    [direct, routed],
    [routed, direct],
  ]) {
    const [account] = collectLimitAccounts(
      new Map([[EnvironmentId.make("env-a"), { ...laptop, serverConfig: { providers } }]]),
    );
    expect(account?.limits.resetCredits).toEqual(direct.usageLimits?.resetCredits);
    expect(account?.redeem?.input).toEqual({ instanceId: "direct" });
    expect(
      resetCreditChoices(account!.limits.resetCredits!, account!.redeem!.input, now)[0]?.input,
    ).toEqual({ instanceId: "direct", creditId: "direct-grant" });
  }
});
