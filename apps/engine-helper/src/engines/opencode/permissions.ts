import type { RuntimeMode } from "@goat2/contracts-rs";
import type { PermissionRuleset, QuestionRequest } from "@opencode-ai/sdk/v2";

// Adapted from permissionRules.ts:65-135 at 916b5ccc1b2; GOAT 2 supplies runtimeMode only.
export function permissionRules(mode: RuntimeMode): PermissionRuleset {
  if (mode === "full-access") return [
    { permission: "*", pattern: "*", action: "allow" },
    { permission: "external_directory", pattern: "*", action: "allow" },
  ];
  const restricted = ["bash", "edit", "webfetch", "websearch", "codesearch", "external_directory", "doom_loop"];
  const allowed = ["question", "read", "glob", "grep", "lsp", "todowrite", "task", "skill"];
  return [
    { permission: "*", pattern: "*", action: "deny" },
    ...restricted.map((permission) => ({ permission, pattern: "*", action: "deny" as const })),
    { permission: "*", pattern: "*", action: "ask" },
    ...restricted.map((permission) => ({ permission, pattern: "*", action: "ask" as const })),
    ...allowed.map((permission) => ({ permission, pattern: "*", action: "allow" as const })),
    { permission: "read", pattern: "*.env", action: "ask" },
    { permission: "read", pattern: "*.env.*", action: "ask" },
    { permission: "read", pattern: "*.env.example", action: "allow" },
    ...(mode === "auto-accept-edits" ? [{ permission: "edit", pattern: "*", action: "allow" as const }] : []),
  ];
}

// permissionRules.ts:500-532: preserve child denies, never broaden the parent policy with child allows.
export function ownsSubagentDeny(native: PermissionRuleset, metadata?: Record<string, unknown>): boolean {
  const last = native.at(-1);
  return metadata?.goatSubagentDeny === true && last?.permission === "task" && last.pattern === "*" && last.action === "deny";
}
export function childPermissionRules(mode: RuntimeMode, native: PermissionRuleset, previousParents: ReadonlyArray<PermissionRuleset> = [], subagentsDenied = false, metadata?: Record<string, unknown>): PermissionRuleset {
  const parent = permissionRules(mode);
  if (ownsSubagentDeny(native, metadata)) native = native.slice(0, -1);
  const inherited = parent.filter((rule) => rule.permission === "external_directory" || rule.action === "deny");
  const blocks = [...previousParents, ...parentPermissionBases([], metadata), parent].flatMap((rules) => [rules, rules.filter((rule) => rule.permission === "external_directory" || rule.action === "deny")]).filter((rules) => rules.length > 0).sort((a, b) => b.length - a.length);
  const local: PermissionRuleset = [];
  for (let offset = 0; offset < native.length;) {
    const inheritedBlock = blocks.find((rules) => startsWith(native, rules, offset));
    if (inheritedBlock) offset += inheritedBlock.length;
    else local.push(native[offset++]!);
  }
  const child = local.filter((rule) => rule.action === "deny" && !inherited.some((base) => base.permission === rule.permission && base.pattern === rule.pattern && base.action === rule.action));
  return [...parent, ...child, ...(subagentsDenied ? [{ permission: "task", pattern: "*", action: "deny" as const }] : [])];
}

const equalRule = (a: PermissionRuleset[number], b: PermissionRuleset[number]) => a.permission === b.permission && a.pattern === b.pattern && a.action === b.action;
const startsWith = (rules: PermissionRuleset, prefix: PermissionRuleset, offset = 0) => prefix.every((rule, index) => rules[offset + index] !== undefined && equalRule(rules[offset + index]!, rule));
function parseBase(value: unknown): PermissionRuleset | undefined {
  if (!Array.isArray(value) || !value.length || !value.every((rule: unknown) => typeof rule === "object" && rule !== null && "permission" in rule && typeof rule.permission === "string" && "pattern" in rule && typeof rule.pattern === "string" && "action" in rule && ["allow", "ask", "deny"].includes(String(rule.action)))) return undefined;
  return value as PermissionRuleset;
}
function recordedBase(metadata: Record<string, unknown> | undefined): PermissionRuleset | undefined { return parseBase(metadata?.goatPermissionBase); }
export function parentPermissionBases(native: PermissionRuleset, metadata?: Record<string, unknown>): PermissionRuleset[] {
  const previous = Array.isArray(metadata?.goatPreviousPermissionBases) ? metadata.goatPreviousPermissionBases : [];
  const history = Array.isArray(metadata?.goatPermissionBaseHistory) ? metadata.goatPermissionBaseHistory : [];
  return [...previous, ...history, metadata?.goatPermissionBase].slice(-16).flatMap((value) => { const base = parseBase(value); return base ? [base] : []; }).concat(native.length ? [native] : []);
}
// permissionRules.ts:300-340, 539-572: replace GOAT's base while retaining native rules and metadata.
export function resumePermissionRules(mode: RuntimeMode, native: PermissionRuleset, metadata?: Record<string, unknown>) {
  const base = permissionRules(mode);
  const previous = Array.isArray(metadata?.goatPreviousPermissionBases) ? metadata.goatPreviousPermissionBases.flatMap((value) => { const parsed = parseBase(value); return parsed ? [parsed] : []; }) : [];
  const current = recordedBase(metadata);
  const candidates = [...previous, ...(current ? [current] : [])].sort((a, b) => b.length - a.length);
  let recorded: PermissionRuleset | undefined;
  let kept = native;
  let found = false;
  let droppedUnverifiedAllows = false;
  for (let offset = native.length - 1; offset >= 0; offset--) {
    const match = candidates.find((candidate) => startsWith(native, candidate, offset));
    if (match) { recorded = match; kept = native.slice(offset + match.length); found = true; break; }
  }
  if (!found) {
    const known = (["full-access", "approval-required", "auto-accept-edits", "auto"] as const).map(permissionRules).sort((a, b) => b.length - a.length).find((candidate) => startsWith(native, candidate));
    if (known) kept = native.slice(known.length);
    else if (native[0]?.permission === "*" && native[0].pattern === "*" && ["allow", "deny"].includes(native[0].action)) {
      // v1's legacy-prefix heuristic can consume native restrictions; retain deny and ask rules when the base is unknown.
      kept = native.filter((rule) => rule.action === "deny" || rule.action === "ask");
      droppedUnverifiedAllows = native.some((rule) => rule.action === "allow");
    }
  }
  if (found && recorded && (recorded.length !== base.length || !startsWith(recorded, base)) && !previous.some((item) => item.length === recorded.length && startsWith(item, recorded))) previous.push(recorded);
  const ownsDeny = ownsSubagentDeny(native, metadata);
  return { permission: [...base, ...kept], metadata: { ...metadata, ...(previous.length ? { goatPreviousPermissionBases: previous.slice(-16) } : {}), goatPermissionBase: base, goatSubagentDeny: ownsDeny }, droppedUnverifiedAllows };
}

// permissionRules.ts:574-594: avoid rewriting a session when its effective policy is unchanged.
export function permissionUpdateNeeded(native: PermissionRuleset, _metadata: Record<string, unknown> | undefined, desired: { permission: PermissionRuleset; metadata: Record<string, unknown> }): boolean {
  return native.length !== desired.permission.length || !startsWith(native, desired.permission);
}

// openCodePermissions.ts:7-16
export function questionId(index: number, question: QuestionRequest["questions"][number]): string {
  const header = question.header.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  return header ? `question-${index}-${header}` : `question-${index}`;
}
