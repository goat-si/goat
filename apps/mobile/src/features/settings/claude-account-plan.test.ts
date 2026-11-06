import { ProviderDriverKind, ProviderInstanceId } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  planClaudeAccount,
  planClaudeAccountEdit,
  planClaudeAccountRemoval,
} from "./claude-account-plan";

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

describe("editing and removing Claude accounts", () => {
  it("updates the config directory while preserving other instance settings", () => {
    const existing = {
      driver: ProviderDriverKind.make("claudeAgent"),
      displayName: "Work",
      config: { homePath: "/old", modelRoute: "opencodex" },
      enabled: true,
    };
    expect(
      planClaudeAccountEdit(ProviderInstanceId.make("claudeAgent_work"), existing, " /new ", true),
    ).toEqual({
      operation: "upsert",
      instanceId: "claudeAgent_work",
      expectedInstance: existing,
      instance: { ...existing, config: { homePath: "/new", modelRoute: "opencodex" } },
    });
  });
  it("allows removing an added instance but keeps the default instance", () => {
    expect(planClaudeAccountRemoval(ProviderInstanceId.make("claudeAgent_work"))).toEqual({
      operation: "remove",
      instanceId: "claudeAgent_work",
    });
    expect(planClaudeAccountRemoval(ProviderInstanceId.make("claudeAgent"))).toBeNull();
  });
});
