import { ProviderDriverKind } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";
import { planClaudeAccount } from "./claude-account-plan";

describe("adding a Claude account", () => {
  it("requires a name and a signed-in folder", () => {
    expect(planClaudeAccount(" ", "/work", {})).toHaveProperty("error");
    expect(planClaudeAccount("Work", " ", {})).toHaveProperty("error");
  });
  it("creates a distinct instance with its own config folder", () => {
    expect(
      planClaudeAccount(" Work ", " /home/work ", {
        claudeAgent_work: { driver: ProviderDriverKind.make("claudeAgent") },
      }),
    ).toEqual({
      mutation: {
        operation: "create",
        instanceId: "claudeAgent_work_2",
        instance: {
          driver: "claudeAgent",
          enabled: true,
          displayName: "Work",
          config: { homePath: "/home/work" },
        },
      },
    });
  });
});
