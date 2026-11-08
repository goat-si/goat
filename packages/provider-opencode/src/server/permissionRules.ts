import type { PermissionRuleset } from "@opencode-ai/sdk/v2";
import type { ProviderRequestKind } from "@goat/contracts";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";

import { nonEmptyString, recordString, recordValue } from "./records.ts";

export type OpenCodePermissionRequestKind = Extract<
  ProviderRequestKind,
  "command" | "file-read" | "file-change"
>;

export function openCodePermissionRequestKind(
  permission: string,
  toolName?: string,
): OpenCodePermissionRequestKind {
  const normalized = permission.toLowerCase();
  const normalizedTool = toolName?.toLowerCase() ?? "";
  if (
    normalized === "edit" ||
    normalized === "write" ||
    normalized === "patch" ||
    normalized === "apply_patch" ||
    normalizedTool === "edit" ||
    normalizedTool === "write" ||
    normalizedTool === "patch" ||
    normalizedTool === "apply_patch"
  ) {
    return "file-change";
  }
  if (
    normalized === "read" ||
    normalized === "glob" ||
    normalized === "grep" ||
    normalized === "lsp" ||
    normalized === "external_directory" ||
    normalizedTool === "read" ||
    normalizedTool.includes("glob") ||
    normalizedTool.includes("grep") ||
    normalizedTool.includes("search")
  ) {
    return "file-read";
  }
  return "command";
}

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
  readonly permission?: PermissionRuleset | undefined;
  readonly metadata?: { readonly [key: string]: unknown } | undefined;
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

const OPENCODE_GOAT_PERMISSION_BASE_KEY = "goatPermissionBase";

const RESTRICTED_PERMISSIONS = new Set<string>(OPENCODE_RESTRICTED_PERMISSIONS);
const ALWAYS_ALLOWED_PERMISSIONS = new Set<string>(OPENCODE_ALWAYS_ALLOWED_PERMISSIONS);
const READ_ENV_PATTERNS = new Set(["*.env", "*.env.*", "*.env.example"]);
const NETWORK_PERMISSIONS = new Set(["webfetch", "websearch", "codesearch"]);

export interface OpenCodeResumePermission {
  readonly permission: PermissionRuleset;
  readonly metadata: { readonly [key: string]: unknown };
  readonly subagentsDenied: boolean;
}

const isPermissionRule = (value: unknown): value is PermissionRuleset[number] => {
  if (typeof value !== "object" || value === null) return false;
  if (!("permission" in value) || !("pattern" in value) || !("action" in value)) return false;
  return (
    typeof value.permission === "string" &&
    typeof value.pattern === "string" &&
    (value.action === "allow" || value.action === "deny" || value.action === "ask")
  );
};

const rulesEqual = (left: PermissionRuleset, right: PermissionRuleset) => {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const rule = left[index];
    const expected = right[index];
    if (rule === undefined || expected === undefined || !permissionRuleEquals(rule, expected)) {
      return false;
    }
  }
  return true;
};

const startsWithRules = (rules: PermissionRuleset, prefix: PermissionRuleset) =>
  prefix.length <= rules.length && rulesEqual(rules.slice(0, prefix.length), prefix);

const storedPermissionBase = (metadata: { readonly [key: string]: unknown } | undefined) => {
  const value = metadata?.[OPENCODE_GOAT_PERMISSION_BASE_KEY];
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const rules: Array<PermissionRuleset[number]> = [];
  for (const entry of value) {
    if (!isPermissionRule(entry)) return undefined;
    rules.push(entry);
  }
  return rules;
};

const isWritableRootPattern = (pattern: string) =>
  pattern.endsWith("/*") && !pattern.slice(0, -2).includes("*");

const isGoatShapedRule = (rule: PermissionRuleset[number]) => {
  if (rule.permission === "*" && rule.pattern === "*") return true;
  if (
    RESTRICTED_PERMISSIONS.has(rule.permission) &&
    rule.pattern === "*" &&
    (rule.action === "deny" || rule.action === "ask")
  ) {
    return true;
  }
  if (
    ALWAYS_ALLOWED_PERMISSIONS.has(rule.permission) &&
    rule.pattern === "*" &&
    rule.action === "allow"
  ) {
    return true;
  }
  if (rule.permission === "read" && READ_ENV_PATTERNS.has(rule.pattern)) return true;
  if (rule.permission === "edit" && rule.pattern === "*" && rule.action === "allow") return true;
  if (NETWORK_PERMISSIONS.has(rule.permission) && rule.pattern === "*" && rule.action === "allow") {
    return true;
  }
  return (
    rule.permission === "external_directory" &&
    rule.action === "allow" &&
    (rule.pattern === "*" || isWritableRootPattern(rule.pattern))
  );
};

const hasGoatSignature = (rules: PermissionRuleset) => {
  const first = rules[0];
  return (
    first !== undefined &&
    first.permission === "*" &&
    first.pattern === "*" &&
    (first.action === "deny" || first.action === "allow")
  );
};

// No stored base: a leading GOAT signature is stripped only through rules GOAT writes.
const stripLegacyGoatPrefix = (rules: PermissionRuleset) => {
  if (!hasGoatSignature(rules)) return rules;
  let index = 0;
  while (index < rules.length) {
    const rule = rules[index];
    if (rule === undefined || !isGoatShapedRule(rule)) break;
    index += 1;
  }
  return rules.slice(index);
};

/** The base GOAT installs, marked so a later resume can tell it from native rules. */
export function openCodeInstalledPermission(
  runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
): {
  readonly permission: PermissionRuleset;
  readonly metadata: { readonly [key: string]: unknown };
} {
  const permission = openCodePermissionRules(runtimePolicy);
  return {
    permission,
    metadata: {
      [OPENCODE_GOAT_PERMISSION_BASE_KEY]: permission,
      [OPENCODE_GOAT_SUBAGENT_DENY_KEY]: false,
    },
  };
}

/** Replace GOAT's base and trailing deny. Rules between them, native or user, stay. */
export function mergeOpenCodeResumePermission(
  session: {
    readonly permission?: PermissionRuleset | undefined;
    readonly metadata?: { readonly [key: string]: unknown } | undefined;
  },
  runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
  subagentsOff: boolean | undefined,
): OpenCodeResumePermission {
  const permission = session.permission ?? [];
  const ownsDeny = openCodeOwnsSubagentDeny(session);
  const withoutDeny = ownsDeny ? permission.slice(0, -1) : permission;
  const storedBase = storedPermissionBase(session.metadata);
  const nextBase = openCodePermissionRules(runtimePolicy);
  let kept = withoutDeny;
  if (storedBase !== undefined && startsWithRules(kept, storedBase)) {
    kept = kept.slice(storedBase.length);
  } else if (startsWithRules(kept, nextBase)) {
    kept = kept.slice(nextBase.length);
  } else if (storedBase === undefined) {
    kept = stripLegacyGoatPrefix(kept);
  }
  const subagentsDenied = subagentsOff ?? ownsDeny;
  const merged = subagentsDenied
    ? [...nextBase, ...kept, OPENCODE_SUBAGENT_DENY]
    : [...nextBase, ...kept];
  return {
    permission: merged,
    metadata: {
      ...session.metadata,
      [OPENCODE_GOAT_PERMISSION_BASE_KEY]: nextBase,
      [OPENCODE_GOAT_SUBAGENT_DENY_KEY]: subagentsDenied,
    },
    subagentsDenied,
  };
}

export function openCodeResumePermissionDiffers(
  session: {
    readonly permission?: PermissionRuleset | undefined;
    readonly metadata?: { readonly [key: string]: unknown } | undefined;
  },
  merged: OpenCodeResumePermission,
): boolean {
  if (!rulesEqual(session.permission ?? [], merged.permission)) return true;
  const recorded = storedPermissionBase(session.metadata);
  const nextBase = storedPermissionBase(merged.metadata);
  if (recorded === undefined || nextBase === undefined || !rulesEqual(recorded, nextBase)) {
    return true;
  }
  return (session.metadata?.[OPENCODE_GOAT_SUBAGENT_DENY_KEY] === true) !== merged.subagentsDenied;
}
