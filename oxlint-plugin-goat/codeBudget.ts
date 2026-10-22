// @effect-diagnostics nodeBuiltinImport:off
// Shared by the goat/code-budget rule and update-code-budgets.ts so the lint check and the
// baseline it reads count the same things.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export const MAX_LINES = 1000;

const REPO_ROOT = NodePath.resolve(import.meta.dirname, "..");
export const BASELINE_PATH = NodePath.join(import.meta.dirname, "code-budgets.json");

export interface Budget {
  readonly lines?: number;
  readonly nonNull?: number;
  readonly asAny?: number;
}

export type Baseline = Readonly<Record<string, Budget>>;

export interface Measurement {
  readonly lines: number;
  readonly nonNull: number;
  readonly asAny: number;
}

const TEST_CODE =
  /(?:\.(?:test|spec)\.[cm]?[jt]sx?$)|(?:(?:^|\/)(?:test|tests|testUtils|testing|__tests__)\/)/u;
// Regenerated files grow with their source schema; holding them to a budget would block regeneration.
const GENERATED = /(?:(?:^|\/)_generated\/)|(?:\.(?:gen|generated|graphql)\.[cm]?[jt]sx?$)/u;

export const isTestCode = (file: string) => TEST_CODE.test(file);
export const isGenerated = (file: string) => GENERATED.test(file);

// Oxlint also reads script blocks in .astro and .vue files; their line numbers are not the file's.
const BUDGETED = /\.[cm]?[jt]sx?$/u;
export const isBudgeted = (file: string) => BUDGETED.test(file) && !isGenerated(file);

/** Counts lines the way `wc -l` does, plus a final line without a newline. */
export const countLines = (text: string) => {
  let lines = 0;
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    lines++;
  }
  return text.length > 0 && !text.endsWith("\n") ? lines + 1 : lines;
};

interface TypedNode {
  readonly type: string;
  readonly typeAnnotation?: TypedNode | null;
}

// `value as (any)` wraps the keyword in a TSParenthesizedType.
const unwrapType = (node: TypedNode | null | undefined): TypedNode | null | undefined =>
  node?.type === "TSParenthesizedType" ? unwrapType(node.typeAnnotation) : node;

/** Classifies a node as a non-null assertion (`x!`) or a cast to `any`. */
export const unsafeAssertion = (node: TypedNode): "nonNull" | "asAny" | undefined => {
  if (node.type === "TSNonNullExpression") return "nonNull";
  if (
    (node.type === "TSAsExpression" || node.type === "TSTypeAssertion") &&
    unwrapType(node.typeAnnotation)?.type === "TSAnyKeyword"
  ) {
    return "asAny";
  }
  return undefined;
};

/** What a file may contain. Test code may use `!`, since a failed lookup fails the test. */
export const allowance = (file: string, budget: Budget | undefined): Measurement => ({
  lines: Math.max(budget?.lines ?? 0, MAX_LINES),
  nonNull: isTestCode(file) ? Number.POSITIVE_INFINITY : (budget?.nonNull ?? 0),
  asAny: budget?.asAny ?? 0,
});

let cached: Baseline | undefined;

export const readBaseline = (): Baseline => {
  cached ??= JSON.parse(NodeFS.readFileSync(BASELINE_PATH, "utf8")) as Baseline;
  return cached;
};

/**
 * The path baseline keys and file classification use: repository-relative with forward slashes.
 * A file outside this checkout (a lint fixture in a temp directory) keeps its absolute path.
 */
export const repoPath = (filename: string) => {
  const relative = NodePath.relative(REPO_ROOT, filename);
  const inside =
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${NodePath.sep}`) &&
    !NodePath.isAbsolute(relative);
  return (inside ? relative : filename).split(NodePath.sep).join("/");
};

/**
 * A file's baseline entry. Keys match exactly inside the checkout; a file outside it, which only
 * the rule's tests lint, matches the key its path ends with.
 */
export const budgetFor = (baseline: Baseline, file: string): Budget | undefined => {
  if (Object.hasOwn(baseline, file)) return baseline[file];
  if (!file.startsWith("/") && !/^[A-Za-z]:\//u.test(file)) return undefined;
  const key = Object.keys(baseline).find((candidate) => file.endsWith(`/${candidate}`));
  return key === undefined ? undefined : baseline[key];
};
