import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@goat/contracts";
import { expect, it } from "vite-plus/test";
import { withUsageLimitsCommands } from "./usageLimits.ts";

it("advertises usage limits for supported drivers in a mixed catalog", () => {
  const base: ServerProvider = {
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
  };
  const limits = { checkedAt: "2026-09-03T11:00:00.000Z", windows: [] };
  const selected = { ...base, usageLimits: limits };
  const workspace = {
    ...base,
    workspaceSnapshots: [
      { cwd: "/tmp/project", checkedAt: limits.checkedAt, slashCommands: [], skills: [] },
    ],
  };
  const unrelated = { ...base, driver: ProviderDriverKind.make("claudeAgent") };
  const disabled = { ...unrelated, enabled: false, usageLimits: limits };
  const mixed = withUsageLimitsCommands([selected, workspace, unrelated, disabled], []);
  expect(mixed.map((entry) => entry.slashCommands.map((command) => command.name))).toEqual([
    ["usage-limits"],
    ["usage-limits"],
    [],
    [],
  ]);
  expect(mixed[2]).toBe(unrelated);
  expect(mixed[3]).toBe(disabled);
});
