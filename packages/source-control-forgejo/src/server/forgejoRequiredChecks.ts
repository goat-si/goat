import * as Schema from "effect/Schema";
import type { PullRequestCheck } from "@goat/contracts";

// The branch endpoint reports the governing protection rule with repository read access.
export const ForgejoBranchStatusChecks = Schema.Struct({
  enable_status_check: Schema.optional(Schema.Boolean),
  status_check_contexts: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
});

// Forgejo compiles each context with gobwas/glob and no separator, so `*` and `**` both match any
// run of characters, `/` included, and `?` matches one character. Classes, alternation and escapes
// are not handled.
const UNSUPPORTED_GLOB = /[[\]{}\\]/;
// The caller bounds total pattern and name lengths before this matcher can rescan a suffix.
const matchesContext = (glob: string, name: string) => {
  const pattern = Array.from(glob);
  const text = Array.from(name);
  let p = 0;
  let t = 0;
  let star = -1;
  let resume = 0;
  while (t < text.length) {
    // Wildcard first, so a literal `*` in the name never consumes the pattern's `*`.
    if (pattern[p] === "*") {
      star = p++;
      resume = t;
    } else if (p < pattern.length && (pattern[p] === "?" || pattern[p] === text[t])) {
      p++;
      t++;
    } else if (star >= 0) {
      p = star + 1;
      t = ++resume;
    } else {
      return false;
    }
  }
  while (pattern[p] === "*") p++;
  return p === pattern.length;
};

const MAX_MATCH_WORK = 1_000_000;

const exceedsMatchBudget = (
  contexts: ReadonlyArray<string>,
  checks: ReadonlyArray<PullRequestCheck>,
) => {
  if (contexts.length > MAX_MATCH_WORK || checks.length > MAX_MATCH_WORK) return true;
  let patternSize = 0;
  for (const context of contexts) {
    patternSize += context.length + 1;
    if (patternSize > MAX_MATCH_WORK) return true;
  }
  let nameSize = 0;
  for (const check of checks) {
    nameSize += check.name.length + 1;
    if (nameSize > MAX_MATCH_WORK) return true;
  }
  return patternSize * Math.max(nameSize, 1) > MAX_MATCH_WORK;
};

export function markRequiredForgejoChecks(
  checks: ReadonlyArray<PullRequestCheck>,
  branch: typeof ForgejoBranchStatusChecks.Type,
): ReadonlyArray<PullRequestCheck> {
  const contexts = branch.enable_status_check ? (branch.status_check_contexts ?? []) : [];
  if (contexts.length === 0) return checks;
  if (exceedsMatchBudget(contexts, checks)) {
    return [
      ...checks,
      {
        name: contexts[0] ?? "",
        status: "pending",
        description: "Required check pattern cannot be evaluated.",
        url: null,
      },
    ];
  }
  const unsupported = [...new Set(contexts.filter((context) => UNSUPPORTED_GLOB.test(context)))];
  if (unsupported.length > 0) {
    // Keep all observed checks gating, but never pass a policy we cannot evaluate.
    return [
      ...checks,
      ...unsupported.map((name) => ({
        name,
        status: "pending" as const,
        description: "Required check pattern cannot be evaluated.",
        url: null,
      })),
    ];
  }
  const patterns = [...new Set(contexts)];
  const marked = checks.map((check) =>
    patterns.some((pattern) => matchesContext(pattern, check.name))
      ? { ...check, required: true }
      : check,
  );
  // Forgejo keeps an unmatched required pattern pending, including wildcards.
  const missing = patterns.flatMap((name) =>
    !name.trim() || checks.some((check) => matchesContext(name, check.name))
      ? []
      : [{ name, status: "pending", description: null, url: null, required: true } as const],
  );
  return [...marked, ...missing];
}
