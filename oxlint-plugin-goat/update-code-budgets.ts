// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
// Rewrites code-budgets.json, the baseline goat/code-budget holds files to.
//
//   node oxlint-plugin-goat/update-code-budgets.ts         lower entries to what files hold now
//   node oxlint-plugin-goat/update-code-budgets.ts --init  record every file as it is
//
// Lowering never raises an entry or adds a file, so it cannot absorb growth. It prints files over
// budget and exits 1; fix those in the code instead. --init exists to create the baseline.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

import {
  allowance,
  BASELINE_PATH,
  countLines,
  isBudgeted,
  isTestCode,
  MAX_LINES,
  readBaseline,
  unsafeAssertion,
  type Budget,
  type Measurement,
} from "./codeBudget.ts";

// oxc-parser comes with vite-plus, which is how this repo already runs oxlint.
const { parseSync } = NodeModule.createRequire(
  NodeModule.createRequire(import.meta.url).resolve("vite-plus/package.json"),
)("oxc-parser") as {
  parseSync: (filename: string, source: string) => { program: unknown };
};

const root = NodePath.resolve(import.meta.dirname, "..");
// Mirrors lint.ignorePatterns in vite.config.ts; files lint never reads need no budget.
const UNLINTED =
  /^(?:\.repos\/|apps\/mobile\/(?:android|ios)\/|apps\/server\/schema\/|packages\/source-control-github\/schema\/)|(?:^|\/)(?:dist|dist-electron|node_modules)\//u;

const countAssertions = (node: unknown, counts: { nonNull: number; asAny: number }) => {
  if (Array.isArray(node)) {
    for (const child of node) countAssertions(child, counts);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  if ("type" in node && typeof node.type === "string") {
    const kind = unsafeAssertion(node as Parameters<typeof unsafeAssertion>[0]);
    if (kind) counts[kind]++;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key !== "parent") countAssertions(value, counts);
  }
};

const measure = (file: string): Measurement => {
  const text = NodeFS.readFileSync(NodePath.join(root, file), "utf8");
  const counts = { nonNull: 0, asAny: 0 };
  countAssertions(parseSync(file, text).program, counts);
  return { lines: countLines(text), ...counts };
};

/** The entry a file needs to pass as it is now, or undefined when the defaults cover it. */
const needed = (file: string, now: Measurement): Budget | undefined => {
  const entry: { lines?: number; nonNull?: number; asAny?: number } = {};
  if (now.lines > MAX_LINES) entry.lines = now.lines;
  if (now.nonNull > 0 && !isTestCode(file)) entry.nonNull = now.nonNull;
  if (now.asAny > 0) entry.asAny = now.asAny;
  return Object.keys(entry).length > 0 ? entry : undefined;
};

const init = process.argv.includes("--init");
const previous = init ? {} : readBaseline();
const files = NodeChildProcess.execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "--", ".", ":(exclude).repos"],
  { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
)
  .split("\n")
  .filter(
    (file) =>
      isBudgeted(file) && !UNLINTED.test(file) && NodeFS.existsSync(NodePath.join(root, file)),
  )
  .sort();

const next: Record<string, Budget> = {};
const over: Array<string> = [];
for (const file of files) {
  const now = measure(file);
  const entry = needed(file, now);
  if (!entry) continue;
  if (init) {
    next[file] = entry;
    continue;
  }
  const allowed = allowance(file, previous[file]);
  const kept: { lines?: number; nonNull?: number; asAny?: number } = {};
  for (const metric of ["lines", "nonNull", "asAny"] as const) {
    const value = entry[metric];
    if (value === undefined) continue;
    if (value > allowed[metric]) over.push(`${file}: ${metric} ${value} > ${allowed[metric]}`);
    kept[metric] = Math.min(value, allowed[metric]);
  }
  next[file] = kept;
}

const body = Object.entries(next)
  .map(([file, entry]) => `  ${JSON.stringify(file)}: ${JSON.stringify(entry)}`)
  .join(",\n");
NodeFS.writeFileSync(BASELINE_PATH, `{\n${body}\n}\n`);
NodeChildProcess.execFileSync("vp", ["fmt", BASELINE_PATH], { cwd: root, stdio: "ignore" });
console.log(`code-budgets.json: ${Object.keys(next).length} files over a default budget.`);
if (over.length > 0) {
  console.error(`Over budget; shrink these instead of raising the baseline:\n${over.join("\n")}`);
  process.exit(1);
}
