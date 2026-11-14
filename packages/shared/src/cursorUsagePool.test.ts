import { ProviderDriverKind } from "@goat/contracts";
import { expect, it } from "vite-plus/test";
import {
  collectLimitPools,
  cursorUsageWindowDetails,
  displayLimitWindows,
  type LimitAccount,
} from "./usageLimits.ts";

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

it.each([
  {
    reports: [
      [14, 14],
      [14, 14],
    ],
    ids: ["autoPercentUsed"],
    remaining: [86],
    label: "Usage",
  },
  {
    reports: [
      [14, 14],
      [80, 70],
    ],
    ids: ["totalPercentUsed", "autoPercentUsed"],
    remaining: [53, 58],
    label: "Cursor Models",
  },
  {
    reports: [[undefined, 14]],
    ids: ["autoPercentUsed"],
    remaining: [86],
    label: "Cursor Models",
  },
  { reports: [[14, undefined]], ids: ["totalPercentUsed"], remaining: [86], label: null },
])("preserves Cursor totals and scope for $reports", ({ reports, ids, remaining, label }) => {
  const accounts = reports.map(([total, auto], index) => ({
    ...account(String(index), [
      ...(total === undefined ? [] : [{ ...weekly, id: "totalPercentUsed", usedPercent: total }]),
      ...(auto === undefined ? [] : [{ ...weekly, id: "autoPercentUsed", usedPercent: auto }]),
    ]),
    driver: ProviderDriverKind.make("cursor"),
  }));
  const pool = collectLimitPools(accounts, now)[0]!;
  const visible = displayLimitWindows(pool);
  expect(visible.map((window) => window.id)).toEqual(ids);
  expect(visible.map((window) => window.remainingPercent)).toEqual(remaining);
  const details = cursorUsageWindowDetails(ids.at(-1)!, pool);
  expect(details?.label).toBe(label);
  if (label === "Usage") expect(details?.description).toBeUndefined();
});
