/**
 * Pure rename engine behind `scripts/goat-rename.ts`.
 *
 * Rules are explicit (no blanket t3 → goat). A rule rewrites text inside the
 * files its scope selects; a path rule moves files. Lines marked
 * `goat-rename: legacy`, regions between `goat-rename: legacy-begin` and
 * `goat-rename: legacy-end`, matches of keep rules that hold on apply, and
 * exempt files keep their T3 spellings, so a second run is a no-op and
 * compatibility code survives every rerun.
 */

export interface TextRule {
  /** Stable id shown in reports. */
  readonly id: string;
  /** Category used by `--only` and commit grouping. */
  readonly category: string;
  /** Must be global (`g`). */
  readonly find: RegExp;
  readonly replace: string;
  /** Limits the rule to some repo-relative paths. Defaults to every scanned file. */
  readonly scope?: (path: string) => boolean;
}

export interface PathRule {
  readonly id: string;
  readonly category: string;
  /** Matched against the repo-relative path; must be global. */
  readonly find: RegExp;
  readonly replace: string;
  readonly scope?: (path: string) => boolean;
}

export interface KeepRule {
  readonly id: string;
  /** Removed from each line before the residue scan; must be global. */
  readonly pattern: RegExp;
  readonly reason: string;
  readonly scope?: (path: string) => boolean;
  /**
   * Text rules also leave the matches alone. Only for exact patterns: most keeps are
   * scan masks over test input that `--apply` must still rename on an upstream checkout.
   */
  readonly holdsOnApply?: boolean;
}

/**
 * An upstream path GOAT does not keep. `--apply` removes it, so applying the
 * rules to an upstream checkout before a merge turns upstream edits to it into
 * no-ops instead of modify/delete conflicts.
 */
export interface DropRule {
  readonly id: string;
  readonly category: string;
  /** Matched against the repo-relative path; must not be global. */
  readonly find: RegExp;
  readonly reason: string;
}

export const isDropped = (path: string, rules: readonly DropRule[]): boolean =>
  rules.some((rule) => rule.find.test(path));

export const LEGACY_LINE_MARKER = "goat-rename: legacy";
const LEGACY_BEGIN = "goat-rename: legacy-begin";
const LEGACY_END = "goat-rename: legacy-end";

/** Splits text into lines that rules may rewrite and lines they must keep. */
const protectedLines = (lines: readonly string[]): ReadonlySet<number> => {
  const result = new Set<number>();
  let inRegion = false;
  lines.forEach((line, index) => {
    if (line.includes(LEGACY_BEGIN)) inRegion = true;
    if (inRegion || line.includes(LEGACY_LINE_MARKER)) result.add(index);
    if (line.includes(LEGACY_END)) inRegion = false;
  });
  return result;
};

export interface TextResult {
  readonly text: string;
  /** Replacement count per rule id. */
  readonly hits: ReadonlyMap<string, number>;
}

// Private-use code points: no rule pattern matches them, and they read as a non-word boundary.
const HELD_OPEN = "\uE000";
const HELD_CLOSE = "\uE001";
const HELD = /\uE000(\d+)\uE001/g;

export const applyTextRules = (
  path: string,
  text: string,
  rules: readonly TextRule[],
  keeps: readonly KeepRule[] = [],
): TextResult => {
  const active = rules.filter((rule) => rule.scope?.(path) ?? true);
  const hits = new Map<string, number>();
  if (active.length === 0) return { text, hits };
  const holds = keeps.filter((rule) => rule.holdsOnApply === true && (rule.scope?.(path) ?? true));
  const lines = text.split("\n");
  const keep = protectedLines(lines);
  const next = lines.map((line, index) => {
    if (keep.has(index)) return line;
    const held: string[] = [];
    let current = line;
    for (const rule of holds)
      current = current.replace(rule.pattern, (match) => {
        held.push(match);
        return `${HELD_OPEN}${held.length - 1}${HELD_CLOSE}`;
      });
    for (const rule of active) {
      const count = current.match(rule.find)?.length ?? 0;
      if (count === 0) continue;
      current = current.replace(rule.find, rule.replace);
      hits.set(rule.id, (hits.get(rule.id) ?? 0) + count);
    }
    return held.length === 0
      ? current
      : current.replace(
          HELD,
          (placeholder: string, slot: string) => held[Number(slot)] ?? placeholder,
        );
  });
  return { text: next.join("\n"), hits };
};

export const applyPathRules = (path: string, rules: readonly PathRule[]): string => {
  let current = path;
  for (const rule of rules) {
    if (!(rule.scope?.(path) ?? true)) continue;
    current = current.replace(rule.find, rule.replace);
  }
  return current;
};

/** A T3 spelling: `t3` not glued to other digits, as in t3code, T3_HOME, @t3tools, useT3Foo. */
const T3_TOKEN = /(?<![0-9])[Tt]3(?![0-9])/;

export interface Residue {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

/** Lines that still contain a T3 spelling not explained by a keep rule or a legacy marker. */
export const findResidue = (path: string, text: string, keeps: readonly KeepRule[]): Residue[] => {
  const active = keeps.filter((rule) => rule.scope?.(path) ?? true);
  const lines = text.split("\n");
  const keep = protectedLines(lines);
  const result: Residue[] = [];
  lines.forEach((line, index) => {
    if (keep.has(index)) return;
    let stripped = line;
    for (const rule of active) stripped = stripped.replace(rule.pattern, "");
    if (T3_TOKEN.test(stripped)) result.push({ path, line: index + 1, text: line.trim() });
  });
  return result;
};
