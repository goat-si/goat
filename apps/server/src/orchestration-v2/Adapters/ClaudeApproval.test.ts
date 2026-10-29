import { assert, describe, it } from "@effect/vitest";
import { claudeApprovalPresentation, permissionResultFromDecision } from "./ClaudeApproval.ts";

describe("ClaudeAdapterV2 approval presentation", () => {
  it("marks asks that full access could not auto-allow and keeps the CLI's reason", () => {
    const presentation = claudeApprovalPresentation({
      permissionMode: "bypassPermissions",
      prompt: 'Claude wants to run rm -r -- "$rr/$h"',
      callbackOptions: {
        decisionReason: "\u001b[33mDangerous rm on a path built from a variable\u001b[39m",
        suppressAlwaysAllowRule: true,
      },
    });
    assert.deepEqual(presentation, {
      reason: "Dangerous rm on a path built from a variable",
      fullAccessOverride: "provider_check",
      options: [
        { decision: "decline", label: "Decline" },
        { decision: "accept", label: "Approve" },
      ],
    });
  });

  it("attributes a bypass ask to the user's ask rule when one matched", () => {
    const presentation = claudeApprovalPresentation({
      permissionMode: "bypassPermissions",
      prompt: "Claude wants to run git push",
      callbackOptions: {
        matchedAskRule: { source: "userSettings", toolName: "Bash", ruleContent: "git push:*" },
      },
    });
    assert.deepEqual(presentation, { fullAccessOverride: "ask_rule" });
  });

  it("adds nothing to ordinary approvals outside full access", () => {
    const presentation = claudeApprovalPresentation({
      permissionMode: "default",
      prompt: "Run make?",
      callbackOptions: { decisionReason: "Run make?" },
    });
    assert.deepEqual(presentation, {});
  });
});

describe("ClaudeAdapterV2 session permissions", () => {
  it("keeps explicit user refusals classified as user_reject", () => {
    const result = permissionResultFromDecision({
      toolName: "Bash",
      decision: "decline",
      toolInput: { command: "make" },
      toolUseID: "denied-build",
    });
    assert.equal(result.behavior, "deny");
    if (result.behavior !== "deny") return;
    assert.equal(result.decisionClassification, "user_reject");
    assert.equal(result.message, "User declined tool execution.");
    assert.equal(result.interrupt, undefined);
  });

  it("forces suggested permission updates to session scope", () => {
    const result = permissionResultFromDecision({
      toolName: "Bash",
      decision: "acceptForSession",
      toolInput: { command: "git status" },
      toolUseID: "tool-1",
      suggestions: [
        {
          type: "addRules",
          rules: [{ toolName: "Bash", ruleContent: "git status" }],
          behavior: "allow",
          destination: "localSettings",
        },
      ],
    });

    assert.equal(result.behavior, "allow");
    if (result.behavior !== "allow") {
      return;
    }
    assert.deepEqual(result.updatedPermissions, [
      {
        type: "addRules",
        rules: [{ toolName: "Bash", ruleContent: "git status" }],
        behavior: "allow",
        destination: "session",
      },
    ]);
  });

  it("adds a whole-tool session rule when Claude offers no suggestion", () => {
    const result = permissionResultFromDecision({
      toolName: "mcp__t3__custom_tool",
      decision: "acceptForSession",
      toolInput: {},
      toolUseID: "tool-2",
    });

    assert.equal(result.behavior, "allow");
    if (result.behavior !== "allow") {
      return;
    }
    assert.deepEqual(result.updatedPermissions, [
      {
        type: "addRules",
        rules: [{ toolName: "mcp__t3__custom_tool" }],
        behavior: "allow",
        destination: "session",
      },
    ]);
  });
});
