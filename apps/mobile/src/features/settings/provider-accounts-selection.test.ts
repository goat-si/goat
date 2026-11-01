import { ProviderInstanceId } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  orderEnvironmentsForProviderSetup,
  providerSetupLabel,
  providerSetupPrompt,
  selectProviderAccounts,
} from "./provider-accounts-selection";

const claude = {
  instanceId: "claudeAgent",
  driver: "claudeAgent",
  auth: { status: "unauthenticated" },
  listed: true,
};
const codex = {
  instanceId: "codex",
  driver: "codex",
  auth: { status: "authenticated" },
  listed: true,
};
const hidden = {
  instanceId: "custom",
  driver: "custom",
  auth: { status: "unauthenticated" },
  listed: false,
};
const providers = [codex, claude, hidden];
const include = (provider: { readonly listed: boolean }) => provider.listed;

describe("provider account setup selection", () => {
  it("keeps the ordinary account list when nothing is preselected", () => {
    expect(selectProviderAccounts(providers, undefined, include)).toEqual({
      accounts: [codex, claude],
      highlighted: null,
    });
  });

  it("opens on the requested instance and keeps it visible without in-app sign-in", () => {
    const selection = selectProviderAccounts(
      providers,
      { instanceId: ProviderInstanceId.make("custom") },
      include,
    );
    expect(selection.highlighted).toBe(hidden);
    expect(selection.accounts.map((provider) => provider.instanceId)).toEqual([
      "custom",
      "codex",
      "claudeAgent",
    ]);
  });

  it("falls back to an unsigned-in instance of the requested driver", () => {
    const extra = { ...claude, instanceId: "claude-work", auth: { status: "authenticated" } };
    const selection = selectProviderAccounts(
      [extra, claude],
      { driver: "claudeAgent", instanceId: ProviderInstanceId.make("missing") },
      include,
    );
    expect(selection.highlighted?.instanceId).toBe("claudeAgent");
    expect(selection.accounts[0]?.instanceId).toBe("claudeAgent");
  });

  it("moves the requested environment to the top", () => {
    const targets = [{ environmentId: "local" }, { environmentId: "vps" }];
    expect(
      orderEnvironmentsForProviderSetup(targets, "vps").map((target) => target.environmentId),
    ).toEqual(["vps", "local"]);
    expect(orderEnvironmentsForProviderSetup(targets, "local")).toBe(targets);
    expect(orderEnvironmentsForProviderSetup(targets, "gone")).toBe(targets);
  });

  it("names a known driver and explains a missing account", () => {
    expect(providerSetupLabel({ driver: "claudeAgent" })).toBe("Claude");
    expect(providerSetupLabel({ instanceId: ProviderInstanceId.make("claude-work") })).toBe(
      "claude-work",
    );
    expect(providerSetupPrompt({ foundLabel: "Claude", requestedLabel: "Claude" })).toBe(
      "Set up Claude.",
    );
    expect(providerSetupPrompt({ foundLabel: null, requestedLabel: "Claude" })).toContain(
      "isn't on this environment yet",
    );
  });
});
