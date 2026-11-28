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

// permissionRules.ts:175-189: preserve child-specific rules after restoring the parent policy.
export function childPermissionRules(mode: RuntimeMode, native: PermissionRuleset): PermissionRuleset {
  const parent = permissionRules(mode);
  const inherited = parent.filter((rule) => rule.permission === "external_directory" || rule.action === "deny");
  const child = native.filter((rule) => !inherited.some((base) => base.permission === rule.permission && base.pattern === rule.pattern && base.action === rule.action));
  return [...parent, ...child];
}

// openCodePermissions.ts:7-16
export function questionId(index: number, question: QuestionRequest["questions"][number]): string {
  const header = question.header.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  return header ? `question-${index}-${header}` : `question-${index}`;
}
