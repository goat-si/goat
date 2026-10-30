import type { PermissionRuleset } from "@opencode-ai/sdk/v2";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";

import { nonEmptyString, recordString, recordValue } from "./records.ts";

const OPENCODE_ALWAYS_ALLOWED_PERMISSIONS = [
  "question",
  "read",
  "glob",
  "grep",
  "lsp",
  "todowrite",
  "task",
  "skill",
] as const;

const OPENCODE_RESTRICTED_PERMISSIONS = [
  "bash",
  "edit",
  "webfetch",
  "websearch",
  "codesearch",
  "external_directory",
  "doom_loop",
] as const;

/** OpenCode has no OS sandbox; permission rules must enforce non-interactive policies too. */
export function openCodePermissionRules(
  runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
  subagentsOff = false,
): PermissionRuleset {
  const rules = openCodeRuntimePermissionRules(runtimePolicy);
  // OpenCode checks `task` before launching a subagent but has no concurrency cap: a goatclaw
  // limit of zero denies it last, and other limits leave subagents uncapped.
  return subagentsOff ? [...rules, OPENCODE_SUBAGENT_DENY] : rules;
}

const OPENCODE_SUBAGENT_DENY = { permission: "task", pattern: "*", action: "deny" } as const;

export const openCodeDeniesSubagents = (rules: PermissionRuleset) =>
  rules.some((rule) => permissionRuleEquals(rule, OPENCODE_SUBAGENT_DENY));

function openCodeRuntimePermissionRules(
  runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
): PermissionRuleset {
  const sandboxPolicy = recordValue(runtimePolicy, "sandboxPolicy");
  const sandboxType = recordString(sandboxPolicy, "type");
  const rawApprovalPolicy = runtimePolicy.approvalPolicy;
  const approvalPolicy = nonEmptyString(rawApprovalPolicy);
  const requiresApproval =
    approvalPolicy === undefined
      ? (typeof rawApprovalPolicy === "object" && rawApprovalPolicy !== null) ||
        runtimePolicy.runtimeMode !== "full-access"
      : approvalPolicy !== "never";
  const externallySandboxed = sandboxType === "externalSandbox";
  const dangerFullAccess = sandboxType === "dangerFullAccess";
  const implicitFullAccess =
    sandboxType === undefined && runtimePolicy.runtimeMode === "full-access";

  if (!requiresApproval && (externallySandboxed || dangerFullAccess || implicitFullAccess)) {
    return [{ permission: "*", pattern: "*", action: "allow" }];
  }

  // Children initially inherit only denies; seed them before overrides to protect the policy-install gap.
  const rules: PermissionRuleset = [
    { permission: "*", pattern: "*", action: "deny" },
    ...OPENCODE_RESTRICTED_PERMISSIONS.map((permission) => ({
      permission,
      pattern: "*",
      action: "deny" as const,
    })),
  ];

  if (requiresApproval) {
    rules.push({ permission: "*", pattern: "*", action: "ask" });
    for (const permission of OPENCODE_RESTRICTED_PERMISSIONS) {
      rules.push({ permission, pattern: "*", action: "ask" });
    }
  }

  rules.push(
    ...OPENCODE_ALWAYS_ALLOWED_PERMISSIONS.map((permission) => ({
      permission,
      pattern: "*",
      action: "allow" as const,
    })),
  );

  rules.push(
    { permission: "read", pattern: "*.env", action: requiresApproval ? "ask" : "deny" },
    { permission: "read", pattern: "*.env.*", action: requiresApproval ? "ask" : "deny" },
    { permission: "read", pattern: "*.env.example", action: "allow" },
  );

  if (
    runtimePolicy.runtimeMode === "auto-accept-edits" ||
    (!requiresApproval && sandboxType === "workspaceWrite")
  ) {
    rules.push({ permission: "edit", pattern: "*", action: "allow" });
  }

  if (!requiresApproval && recordValue(sandboxPolicy, "networkAccess") === true) {
    for (const permission of ["webfetch", "websearch", "codesearch"] as const) {
      rules.push({ permission, pattern: "*", action: "allow" });
    }
  }

  if (!requiresApproval && sandboxType === "readOnly") {
    const access = recordValue(sandboxPolicy, "access");
    if (recordString(access, "type") === "fullAccess") {
      rules.push({ permission: "external_directory", pattern: "*", action: "allow" });
    }
  }

  if (!requiresApproval && sandboxType === "workspaceWrite") {
    const writableRoots = recordValue(sandboxPolicy, "writableRoots");
    if (Array.isArray(writableRoots)) {
      for (const root of writableRoots) {
        if (typeof root === "string" && root.trim().length > 0) {
          rules.push({
            permission: "external_directory",
            pattern: `${root.replace(/\/$/, "")}/*`,
            action: "allow",
          });
        }
      }
    }
  }

  return rules;
}

function permissionRuleEquals(
  left: PermissionRuleset[number],
  right: PermissionRuleset[number],
): boolean {
  return (
    left.permission === right.permission &&
    left.pattern === right.pattern &&
    left.action === right.action
  );
}

/** Children inherit only deny/external-directory rules; restore parent policy while retaining agent restrictions. */
export function openCodeChildPermissionRules(
  runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
  nativeChildRules: PermissionRuleset,
  subagentsOff = false,
): PermissionRuleset {
  const parentRules = openCodePermissionRules(runtimePolicy, subagentsOff);
  const inheritedRules = parentRules.filter(
    (rule) => rule.permission === "external_directory" || rule.action === "deny",
  );
  const childSpecificRules = nativeChildRules.filter(
    (childRule) =>
      !inheritedRules.some((inheritedRule) => permissionRuleEquals(childRule, inheritedRule)),
  );
  return [...parentRules, ...childSpecificRules];
}
