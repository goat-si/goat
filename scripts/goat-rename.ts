// @effect-diagnostics nodeBuiltinImport:off - This is a repository maintenance script.
/**
 * Reproducible T3 → GOAT renames.
 *
 *   node scripts/goat-rename.ts --apply [--only <category>[,<category>]] [--root <dir>]
 *   node scripts/goat-rename.ts --check [--root <dir>] [--limit <n>]
 *   node scripts/goat-rename.ts --list
 *
 * `--apply` `git rm`s dropped upstream paths, rewrites tracked text files and
 * `git mv`s renamed paths. It is idempotent. `--check` includes non-ignored
 * untracked files unless `--root` is given. It exits 1 when a scanned file has
 * a T3 spelling that no keep rule or legacy marker explains, or a dropped path is back. `--root` runs against another checkout, such as an
 * upstream tag before it is merged.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  applyPathRules,
  applyTextRules,
  findResidue,
  isDropped,
} from "./lib/goat-rename/engine.ts";
import {
  DROP_RULES,
  isExempt,
  KEEP_RULES,
  PATH_RULES,
  TEXT_RULES,
} from "./lib/goat-rename/rules.ts";

const out = (line: string) => process.stdout.write(`${line}\n`);
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

const root = NodePath.resolve(option("--root") ?? process.cwd());
const only = option("--only")?.split(",");
const selected = <T extends { readonly category: string }>(rules: readonly T[]) =>
  only === undefined ? rules : rules.filter((rule) => only.includes(rule.category));

const git = (...gitArgs: string[]) =>
  NodeChildProcess.execFileSync("git", gitArgs, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });

const allTrackedFiles = () =>
  git("ls-files", "-z")
    .split("\0")
    .filter((path) => path.length > 0);

const trackedFiles = () => allTrackedFiles().filter((path) => !isExempt(path));

const readText = (path: string): string | undefined => {
  const absolute = NodePath.join(root, path);
  if (!NodeFS.statSync(absolute, { throwIfNoEntry: false })?.isFile()) return undefined;
  const bytes = NodeFS.readFileSync(absolute);
  return bytes.subarray(0, 8192).includes(0) ? undefined : bytes.toString("utf8");
};

const list = () => {
  for (const rule of TEXT_RULES)
    out(`text  ${rule.category.padEnd(12)} ${rule.id}: ${rule.find} → ${rule.replace}`);
  for (const rule of PATH_RULES)
    out(`path  ${rule.category.padEnd(12)} ${rule.id}: ${rule.find} → ${rule.replace}`);
  for (const rule of DROP_RULES)
    out(`drop  ${rule.category.padEnd(12)} ${rule.id}: ${rule.find} (${rule.reason})`);
  for (const rule of KEEP_RULES) out(`keep  ${rule.id}: ${rule.reason}`);
};

const apply = () => {
  const textRules = selected(TEXT_RULES);
  const pathRules = selected(PATH_RULES);
  const dropRules = selected(DROP_RULES);
  const dropped = allTrackedFiles().filter((path) => isDropped(path, dropRules));
  if (dropped.length > 0) git("rm", "-q", "--", ...dropped);
  const totals = new Map<string, number>();
  let changedFiles = 0;
  for (const path of trackedFiles()) {
    const text = readText(path);
    if (text === undefined) continue;
    const result = applyTextRules(path, text, textRules);
    if (result.text !== text) {
      NodeFS.writeFileSync(NodePath.join(root, path), result.text);
      changedFiles += 1;
    }
    for (const [id, count] of result.hits) totals.set(id, (totals.get(id) ?? 0) + count);
  }
  let moved = 0;
  for (const path of trackedFiles()) {
    const target = applyPathRules(path, pathRules);
    if (target === path) continue;
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, target)), { recursive: true });
    git("mv", path, target);
    moved += 1;
  }
  for (const [id, count] of [...totals].sort()) out(`${id}: ${count}`);
  out(`dropped ${dropped.length} paths, rewrote ${changedFiles} files, moved ${moved} paths`);
};

const check = () => {
  const limit = Number(option("--limit") ?? 200);
  const filesToCheck = [
    ...new Set([
      ...allTrackedFiles(),
      ...(option("--root") === undefined
        ? git("ls-files", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean)
        : []),
    ]),
  ];
  const dropped = filesToCheck
    .filter((path) => isDropped(path, DROP_RULES))
    .map((path) => ({ path, line: 0, text: "(dropped path)" }));
  const residue = filesToCheck
    .filter((path) => !isExempt(path))
    .flatMap((path) => {
      const text = readText(path);
      const fromText = text === undefined ? [] : findResidue(path, text, KEEP_RULES);
      const fromPath =
        findResidue(path, path, KEEP_RULES).length > 0 ? [{ path, line: 0, text: "(path)" }] : [];
      return [...fromPath, ...fromText];
    });
  for (const item of [...dropped, ...residue].slice(0, limit))
    out(`${item.path}:${item.line}: ${item.text.slice(0, 160)}`);
  const files = new Set(residue.map((item) => item.path)).size;
  out(`${residue.length} lines with T3 residue in ${files} files, ${dropped.length} dropped paths`);
  if (residue.length > 0 || dropped.length > 0) process.exitCode = 1;
};

if (flag("--list")) list();
else if (flag("--apply")) apply();
else if (flag("--check")) check();
else {
  process.stderr.write(
    "usage: node scripts/goat-rename.ts --apply [--only <categories>] [--root <dir>] | --check [--limit <n>] | --list\n",
  );
  process.exitCode = 2;
}
