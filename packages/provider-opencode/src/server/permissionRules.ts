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
  const parentRules = openCodePermissionRules(runtimePolicy);
  const inheritedRules = parentRules.filter(
    (rule) => rule.permission === "external_directory" || rule.action === "deny",
  );
  const childSpecificRules = nativeChildRules.filter(
    (childRule) =>
      !inheritedRules.some((inheritedRule) => permissionRuleEquals(childRule, inheritedRule)),
  );
  return withOpenCodeSubagentDeny([...parentRules, ...childSpecificRules], false, subagentsOff);
}

// OpenCode checks `task` before launching a subagent but has no concurrency cap: a goatclaw limit of
// zero appends this deny last, and other limits leave subagents uncapped.
const OPENCODE_SUBAGENT_DENY = { permission: "task", pattern: "*", action: "deny" } as const;

/** Session metadata that marks the trailing deny as GOAT's, so a deny GOAT did not add stays. */
export const OPENCODE_GOAT_SUBAGENT_DENY_KEY = "goatSubagentDeny";

const endsWithSubagentDeny = (rules: PermissionRuleset) => {
  const last = rules.at(-1);
  return last !== undefined && permissionRuleEquals(last, OPENCODE_SUBAGENT_DENY);
};

export const openCodeOwnsSubagentDeny = (session: {
  readonly permission?: PermissionRuleset;
  readonly metadata?: { readonly [key: string]: unknown };
}) =>
  session.metadata?.[OPENCODE_GOAT_SUBAGENT_DENY_KEY] === true &&
  endsWithSubagentDeny(session.permission ?? []);

/** The rules with GOAT's trailing deny added or, when GOAT owns it, removed. */
export function withOpenCodeSubagentDeny(
  rules: PermissionRuleset,
  goatOwnsDeny: boolean,
  subagentsOff: boolean,
): PermissionRuleset {
  const base = goatOwnsDeny && endsWithSubagentDeny(rules) ? rules.slice(0, -1) : rules;
  return subagentsOff ? [...base, OPENCODE_SUBAGENT_DENY] : base;
}
