import {
  ProviderDriverKind,
  ProviderInstanceId,
  UsageLimitSourceId,
  type ServerProvider,
} from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  hasProviderUsageLimits,
  sameUsageLimitCommandCoverage,
  withUsageLimitsCommands,
} from "./usageLimits.ts";

const provider = (patch: Partial<ServerProvider>): ServerProvider => ({
  instanceId: ProviderInstanceId.make("claudeAgent"),
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-03T11:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  ...patch,
});

describe("/usage-limits non-hub quota source", () => {
  it("does not offer the command to every provider while a non-cliproxy quota source is down", () => {
    const unrelated = provider({ driver: ProviderDriverKind.make("claudeAgent") });
    const quotaSource = {
      id: UsageLimitSourceId.make("opencodex-quota"),
      kind: "opencodex" as const,
      label: "My quota server",
      checkedAt: "2026-09-03T11:00:00.000Z",
      accounts: [],
    };
    const down = { ...quotaSource, error: "Could not read the quota source." };
    expect(withUsageLimitsCommands([unrelated], [quotaSource])[0]).toBe(unrelated);
    expect(withUsageLimitsCommands([unrelated], [down])[0]).toBe(unrelated);
    expect(hasProviderUsageLimits(unrelated.driver, [unrelated], [down])).toBe(false);
    expect(sameUsageLimitCommandCoverage([quotaSource], [down])).toBe(true);
  });
});
