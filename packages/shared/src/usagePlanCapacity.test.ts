import { ProviderDriverKind } from "@goat/contracts";
import { expect, it } from "vite-plus/test";
import { collectLimitPools, type LimitAccount } from "./usageLimits.ts";

const now = Date.parse("2026-09-03T12:00:00.000Z");
const weekly = {
  id: "seven_day",
  kind: "weekly",
  label: "Weekly",
  windowDurationMins: 10080,
  resetsAt: "2026-09-03T14:00:00.000Z",
} as const;
const account = (key: string, windows: LimitAccount["limits"]["windows"]): LimitAccount => ({
  key,
  driver: ProviderDriverKind.make("claudeAgent"),
  displayName: key,
  email: undefined,
  plan: undefined,
  accentColor: undefined,
  environments: [],
  sourceLabel: "Hub",
  redeem: null,
  limits: { checkedAt: "2026-09-03T11:00:00.000Z", windows },
});

it("weights pooled Codex quota and resets by plan capacity", () => {
  const accounts = [
    {
      ...account("pro", [{ ...weekly, id: "secondary", usedPercent: 100 }]),
      driver: ProviderDriverKind.make("codex"),
      plan: "ChatGPT Pro 200 Subscription",
    },
    {
      ...account("plus", [{ ...weekly, id: "secondary", usedPercent: 0 }]),
      driver: ProviderDriverKind.make("codex"),
      plan: "ChatGPT Plus Subscription",
    },
  ];
  const window = collectLimitPools(accounts, now)[0]?.windows[0];
  expect(window?.remainingPercent).toBe(5);
  expect(
    window?.resets.map(({ member, restoresPercent }) => [member.account.key, restoresPercent]),
  ).toContainEqual(["pro", 95]);
});
