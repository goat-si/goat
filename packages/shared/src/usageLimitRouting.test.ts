import {
  ProviderDriverKind,
  ProviderInstanceId,
  UsageLimitSourceId,
  type ServerProvider,
} from "@goat/contracts";
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

describe("model-routed usage", () => {
  const limits = { checkedAt: "2026-09-03T11:00:00.000Z", windows: [window] };
  const selected = provider({
    usageLimits: limits,
    auth: { status: "authenticated", email: "same@example.com" },
  });
  const sources = [
    {
      id: UsageLimitSourceId.make("hub"),
      kind: "cliproxy" as const,
      label: "Accounts",
      origin: "http://hub:8317",
      checkedAt: limits.checkedAt,
      accounts: [
        {
          id: "duplicate",
          driver: selected.driver,
          email: "SAME@example.com",
          usageLimits: limits,
        },
        { id: "oss", driver: selected.driver, plan: "Codex OSS", usageLimits: limits },
        { id: "other-provider", driver: ProviderDriverKind.make("claude"), usageLimits: limits },
      ],
    },
  ];

  it("shows a proxied instance the hub accounts its model routes to, of any driver", () => {
    const routed = [
      {
        ...sources[0]!,
        accounts: sources[0]!.accounts.map((account) =>
          account.id === "oss" ? { ...account, models: ["gpt-5.6-sol"] } : account,
        ),
      },
    ];
    const proxy = provider({
      instanceId: ProviderInstanceId.make("claudex"),
      driver: ProviderDriverKind.make("claudeAgent"),
      auth: { status: "authenticated", type: "customEndpoint", endpoint: "http://hub:8317" },
    });
    // regression: #30778 a local login the hub does not route to is not this thread's account
    const unrelated = provider({
      instanceId: ProviderInstanceId.make("codex-personal"),
      usageLimits: limits,
      auth: { status: "authenticated", email: "personal@example.com" },
    });
    const ids = (instance: ServerProvider, model: string | null) =>
      collectProviderUsageLimits(
        instance.instanceId,
        [selected, proxy, unrelated],
        routed,
        now,
        model,
      )?.accounts.map((account) => account.id);
    expect(ids(proxy, "gpt-5.6-sol[1m]")).toEqual(["codex", "hub:oss"]);
    // regression: #30778 another hub's model list does not decide this hub's routing
    const other = {
      ...routed[0]!,
      id: UsageLimitSourceId.make("other"),
      origin: "http://other:8317",
      accounts: [
        {
          id: "x",
          driver: ProviderDriverKind.make("grok"),
          models: ["gpt-5.6-sol"],
          usageLimits: limits,
        },
      ],
    };
    expect(
      collectProviderUsageLimits(
        proxy.instanceId,
        [selected, proxy],
        [other, ...routed],
        now,
        "gpt-5.6-sol",
      )?.accounts.map((account) => account.id),
    ).toEqual(["codex", "hub:oss"]);
    // regression: #30778 a custom endpoint other than the hub does not follow the hub's routing
    const elsewhere = { ...proxy, auth: { ...proxy.auth, endpoint: "http://other:8317" } };
    expect(
      collectProviderUsageLimits(
        proxy.instanceId,
        [selected, elsewhere],
        routed,
        now,
        "gpt-5.6-sol",
      ),
    ).toBeNull();
    expect(ids(selected, "gpt-5.6-sol")).toEqual(["codex", "codex-personal", "hub:oss"]);
  });
});
