import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  UsageLimitSourceId,
} from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import { collectProviderUsageLimits, collectLimitAccounts } from "./usageLimits.ts";

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

describe("proxy labels", () => {
  const checkedAt = "2026-09-03T11:00:00.000Z";
  const claude = ProviderDriverKind.make("claudeAgent");
  const source = {
    id: UsageLimitSourceId.make("hub"),
    kind: "cliproxy" as const,
    label: "hub",
    checkedAt,
  };
  const laptop = { entry: { target: { label: "Laptop" } } };
  it("labels a default-named instance merged with a hub account by e-mail, keeping a chosen name", () => {
    const native = provider({
      driver: claude,
      instanceId: ProviderInstanceId.make("claudeAgent"),
      displayName: "Claude",
      auth: { status: "authenticated", email: "a@example.com" },
      usageLimits: { checkedAt, windows: [window] },
    });
    const named = provider({
      driver: claude,
      instanceId: ProviderInstanceId.make("claude-work"),
      displayName: "Work",
      auth: { status: "authenticated", email: "b@example.com" },
      usageLimits: { checkedAt, windows: [window] },
    });
    const hubAccount = (email: string) => ({
      id: `claude-${email}.json`,
      driver: claude,
      email,
      usageLimits: { checkedAt, windows: [window] },
    });
    const input = new Map([
      [
        EnvironmentId.make("env-a"),
        {
          ...laptop,
          serverConfig: {
            providers: [native, named],
            usageLimitSources: [
              {
                ...source,
                accounts: [
                  { ...hubAccount("a@example.com"), label: "Personal" },
                  hubAccount("b@example.com"),
                  hubAccount("c@example.com"),
                ],
              },
            ],
          },
        },
      ],
    ]);
    expect(
      collectLimitAccounts(input).map(({ displayName, email }) => ({ displayName, email })),
    ).toEqual([
      { displayName: "Personal", email: "a@example.com" },
      { displayName: "Work", email: "b@example.com" },
      { displayName: null, email: "c@example.com" },
    ]);
  });

  const limits = { checkedAt, windows: [window] };
  const selected = provider({
    usageLimits: limits,
    auth: { status: "authenticated", email: "same@example.com" },
  });
  const sources = [{ ...source, accounts: [] }];
  it("labels hub rows by account id without .json", () => {
    const hub = [
      {
        ...sources[0]!,
        label: "CLIProxyAPI",
        accounts: [
          {
            id: "claude-b@example.com.json",
            driver: selected.driver,
            email: "b@example.com",
            usageLimits: limits,
          },
          { id: "team-seat.json", driver: selected.driver, usageLimits: limits },
        ],
      },
    ];
    const report = collectProviderUsageLimits(selected.instanceId, [selected], hub, now);
    expect(
      report?.accounts.filter((account) => account.sourceLabel).map((account) => account.label),
    ).toEqual(["CLIProxyAPI · claude-b@example.com", "CLIProxyAPI · team-seat"]);
  });
});
