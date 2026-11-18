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
    // OpenCode task children inherit external-directory and deny rules at creation.
    return [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "external_directory", pattern: "*", action: "allow" },
    ];
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

const inheritedChildRules = (rules: PermissionRuleset) =>
  rules.filter((rule) => rule.permission === "external_directory" || rule.action === "deny");

/** Children inherit only deny/external-directory rules; restore parent policy while retaining agent restrictions. */
export function openCodeChildPermissionRules(
  runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
  nativeChildRules: PermissionRuleset,
  subagentsOff = false,
): PermissionRuleset {
  const parentRules = openCodePermissionRules(runtimePolicy);
  const inheritedRules = inheritedChildRules(parentRules);
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
const PREVIOUS_PERMISSION_BASES_KEY = "goatPreviousPermissionBases";
const PERMISSION_BASE_HISTORY_KEY = "goatPermissionBaseHistory";
const MAX_PERMISSION_BASE_HISTORY = 16;

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

export const openCodePermissionRulesEqual = (left: PermissionRuleset, right: PermissionRuleset) => {
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

const startsWithRules = (rules: PermissionRuleset, prefix: PermissionRuleset, offset = 0) =>
  prefix.every((rule, index) => {
    const current = rules[offset + index];
    return current !== undefined && permissionRuleEquals(current, rule);
  });

const readPermissionBase = (value: unknown) => {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const rules: Array<PermissionRuleset[number]> = [];
  for (const entry of value) {
    if (!isPermissionRule(entry)) return undefined;
    rules.push(entry);
  }
  return rules;
};

const readPermissionBases = (
  metadata: { readonly [key: string]: unknown } | undefined,
  key: string,
): ReadonlyArray<PermissionRuleset> => {
  const history = metadata?.[key];
  return Array.isArray(history)
    ? history.slice(-MAX_PERMISSION_BASE_HISTORY).flatMap((entry) => {
        const base = readPermissionBase(entry);
        return base === undefined ? [] : [base];
      })
    : [];
};

export const openCodePreviousPermissionBases = (
  metadata: { readonly [key: string]: unknown } | undefined,
) => readPermissionBases(metadata, PREVIOUS_PERMISSION_BASES_KEY);

function rememberPermissionBaseHistory(
  metadata: { readonly [key: string]: unknown } | undefined,
  next: ReadonlyArray<PermissionRuleset>,
) {
  const history: PermissionRuleset[] = [];
  for (const base of [...readPermissionBases(metadata, PERMISSION_BASE_HISTORY_KEY), ...next]) {
    const duplicate = history.findIndex((candidate) =>
      openCodePermissionRulesEqual(candidate, base),
    );
    if (duplicate >= 0) history.splice(duplicate, 1);
    history.push(base);
  }
  return history.slice(-MAX_PERMISSION_BASE_HISTORY);
}

const storedPermissionBase = (metadata: { readonly [key: string]: unknown } | undefined) =>
  readPermissionBase(metadata?.[OPENCODE_GOAT_PERMISSION_BASE_KEY]);

function readOpenCodeSessionPermission(
  session: Parameters<typeof mergeOpenCodeResumePermission>[0],
) {
  const permission = session.permission ?? [];
  const bases = [...openCodePreviousPermissionBases(session.metadata)];
  const current = storedPermissionBase(session.metadata);
  if (current !== undefined) bases.push(current);
  bases.sort((left, right) => right.length - left.length);
  // Some OpenCode versions append session.update rules. The last verified base owns the effective suffix.
  if (bases.length > 0) {
    for (let offset = permission.length - 1; offset >= 0; offset--) {
      const base = bases.find((candidate) => startsWithRules(permission, candidate, offset));
      if (base !== undefined) return { base, permission: permission.slice(offset) };
    }
  }
  return { base: undefined, permission };
}

export const openCodeRecordedPermissionBase = (
  session: Parameters<typeof mergeOpenCodeResumePermission>[0],
) => readOpenCodeSessionPermission(session).base;

export const openCodeEffectivePermission = (
  session: Parameters<typeof mergeOpenCodeResumePermission>[0],
) => readOpenCodeSessionPermission(session).permission;

export const openCodeParentPermissionBases = (
  session: Parameters<typeof mergeOpenCodeResumePermission>[0],
): ReadonlyArray<PermissionRuleset> => {
  const previous = rememberPermissionBaseHistory(
    session.metadata,
    openCodePreviousPermissionBases(session.metadata),
  );
  const current = openCodeRecordedPermissionBase(session);
  return current === undefined ? previous : [...previous, current];
};

export const openCodeRememberPermissionBases = (
  merged: OpenCodeResumePermission,
  previous: ReadonlyArray<PermissionRuleset>,
): OpenCodeResumePermission => ({
  ...merged,
  metadata: {
    ...merged.metadata,
    [PREVIOUS_PERMISSION_BASES_KEY]: previous.slice(-MAX_PERMISSION_BASE_HISTORY),
    [PERMISSION_BASE_HISTORY_KEY]: rememberPermissionBaseHistory(merged.metadata, previous),
  },
});

export const openCodeClearPreviousPermissionBases = (
  metadata: { readonly [key: string]: unknown } | undefined,
) => {
  if (metadata === undefined || !(PREVIOUS_PERMISSION_BASES_KEY in metadata)) return undefined;
  const { [PREVIOUS_PERMISSION_BASES_KEY]: _, ...remaining } = metadata;
  return {
    ...remaining,
    [PERMISSION_BASE_HISTORY_KEY]: rememberPermissionBaseHistory(
      metadata,
      openCodePreviousPermissionBases(metadata),
    ),
  };
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

/** The base GOAT installs, marked so a later resume can tell it from native rules. OpenCode
 * replaces the whole metadata bag on update, so the session's existing keys are carried along. */
export function openCodeInstalledPermission(
  runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
  existingMetadata?: { readonly [key: string]: unknown },
): {
  readonly permission: PermissionRuleset;
  readonly metadata: { readonly [key: string]: unknown };
} {
  const permission = openCodePermissionRules(runtimePolicy);
  return {
    permission,
    metadata: {
      ...existingMetadata,
      [OPENCODE_GOAT_PERMISSION_BASE_KEY]: permission,
      [OPENCODE_GOAT_SUBAGENT_DENY_KEY]: false,
    },
  };
}

const legacyScopedInheritedPrefix = inheritedChildRules(
  openCodePermissionRules({
    runtimeMode: "approval-required",
    approvalPolicy: "never",
    interactionMode: "default",
    cwd: null,
  }),
);

const legacyInheritedBlocks = (["full-access", "approval-required"] as const).map((runtimeMode) =>
  inheritedChildRules(
    openCodePermissionRules({ runtimeMode, interactionMode: "default", cwd: null }),
  ),
);

function withoutInheritedChildRules(
  rules: PermissionRuleset,
  parentBases: ReadonlyArray<PermissionRuleset>,
): PermissionRuleset {
  const verifiedBlocks = parentBases.flatMap((base) => [base, inheritedChildRules(base)]);
  const leadingBlocks = [...legacyInheritedBlocks, ...verifiedBlocks];
  const unmatched: PermissionRuleset = [];
  let offset = 0;
  while (offset < rules.length) {
    let matched = 0;
    const leading = unmatched.length === 0;
    for (const block of leading ? leadingBlocks : verifiedBlocks) {
      if (block.length > matched && startsWithRules(rules, block, offset)) matched = block.length;
    }
    // Only verified parent blocks can be removed after a native rule interrupts the prefix.
    if (leading && startsWithRules(rules, legacyScopedInheritedPrefix, offset)) {
      let end = offset + legacyScopedInheritedPrefix.length;
      while (end < rules.length) {
        const rule = rules[end];
        if (
          rule?.permission !== "external_directory" ||
          rule.action !== "allow" ||
          (rule.pattern !== "*" && !isWritableRootPattern(rule.pattern))
        )
          break;
        end++;
      }
      if (end > offset + legacyScopedInheritedPrefix.length)
        matched = Math.max(matched, end - offset);
    }
    if (matched > 0) {
      offset += matched;
    } else {
      const rule = rules[offset++];
      if (rule !== undefined) unmatched.push(rule);
    }
  }
  return unmatched;
}

export function openCodeInstalledChildPermission(
  session: Parameters<typeof mergeOpenCodeResumePermission>[0],
  runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
  subagentsOff: boolean,
  previousParentBases: ReadonlyArray<PermissionRuleset> = [],
): OpenCodeResumePermission & { readonly discardedAllows: number } {
  const installed = openCodeInstalledPermission(runtimePolicy, session.metadata);
  const { base: recorded, permission } = readOpenCodeSessionPermission(session);
  const previous = withOpenCodeSubagentDeny(permission, openCodeOwnsSubagentDeny(session), false);
  const nativeRules =
    recorded === undefined
      ? withoutInheritedChildRules(previous, previousParentBases)
      : previous.slice(recorded.length);
  const seen = new Set<string>();
  const nativeDenies: PermissionRuleset = [];
  let discardedAllows = 0;
  for (const rule of nativeRules) {
    const key = permissionRuleKey(rule);
    if (seen.has(key)) continue;
    seen.add(key);
    if (rule.action === "deny") nativeDenies.push(rule);
    if (rule.action === "allow" && !isGoatShapedRule(rule)) discardedAllows++;
  }
  return {
    permission: withOpenCodeSubagentDeny(
      [...installed.permission, ...nativeDenies],
      false,
      subagentsOff,
    ),
    metadata: { ...installed.metadata, [OPENCODE_GOAT_SUBAGENT_DENY_KEY]: subagentsOff },
    subagentsDenied: subagentsOff,
    discardedAllows,
  };
}

const permissionRuleKey = ({ permission, pattern, action }: PermissionRuleset[number]) =>
  `${action}:${permission.length}:${permission}${pattern}`;

/** Replace GOAT's base and trailing deny. Rules between them, native or user, stay. */
export function mergeOpenCodeResumePermission(
  session: {
    readonly permission?: PermissionRuleset | undefined;
    readonly metadata?: { readonly [key: string]: unknown } | undefined;
  },
  runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
  subagentsOff: boolean | undefined,
): OpenCodeResumePermission {
  const { base: storedBase, permission } = readOpenCodeSessionPermission(session);
  const ownsDeny = openCodeOwnsSubagentDeny(session);
  const withoutDeny = ownsDeny ? permission.slice(0, -1) : permission;
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
  if (!openCodePermissionRulesEqual(openCodeEffectivePermission(session), merged.permission)) {
    return true;
  }
  const recorded = storedPermissionBase(session.metadata);
  const nextBase = storedPermissionBase(merged.metadata);
  if (
    recorded === undefined ||
    nextBase === undefined ||
    !openCodePermissionRulesEqual(recorded, nextBase)
  ) {
    return true;
  }
  return (session.metadata?.[OPENCODE_GOAT_SUBAGENT_DENY_KEY] === true) !== merged.subagentsDenied;
}
