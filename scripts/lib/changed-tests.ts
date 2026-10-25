// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const CODE = /\.[cm]?[jt]sx?$/;
const TEST = /\.test\.[cm]?[jt]sx?$/;
/** An app's src directory, every .ts/.tsx of which its React Compiler coverage suite compiles. */
const APP_SOURCE = /^apps\/[^/]+\/src\//;
const COMPILED = /\.tsx?$/;
const COVERAGE_SUITE = "reactCompilerCoverage.test.ts";

/** Text GOAT sends to providers: instruction sections, runtime notes, the memory frame. */
const PROMPT_TEXT =
  /^(?:packages\/provider-[^/]+\/src\/server|apps\/server\/src\/provider|apps\/server\/src\/orchestration-v2\/testkit)\/[^/]*(?:Instructions|memoryContext)\.ts$/;
const REPLAY_DIR = "apps/server/src/orchestration-v2/testkit";
const REPLAY_SUITE = /Replay.*\.integration\.test\.ts$/;

/** A failed lookup would silently drop suites, so anything but a clean answer throws. */
const git = (root: string, args: ReadonlyArray<string>) => {
  const result = NodeChildProcess.spawnSync("git", args, { cwd: root, encoding: "utf8" });
  // git grep exits 1 when nothing matches.
  if (result.status === 1 && args[0] === "grep") return [];
  if (result.status !== 0)
    throw new Error(`git ${args[0]} failed in ${root}: ${result.stderr || result.error}`);
  return result.stdout.split("\n").filter(Boolean);
};

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Prompt text reaches recorded provider payloads through adapters and the replay harness, so the
 * suites that compare it are never beside it (#901). The modules compose each other, so a change
 * to one runs every replay suite and the tests that import any prompt module, directly or through
 * a testkit.
 */
function promptTextTests(root: string): ReadonlyArray<string> {
  const moduleName = (path: string) => escapeRegExp(NodePath.basename(path).replace(CODE, ""));
  const importing = (module: string) =>
    git(root, [
      "grep",
      "-l",
      "-E",
      `[/"'](${module})(\\.ts)?["']`,
      "--",
      "*.test.ts",
      "*.test.tsx",
      "*.testkit.ts",
    ]);
  const modules = git(root, ["ls-files", "--", "apps", "packages"]).filter(
    (path) => PROMPT_TEXT.test(path) && !TEST.test(path),
  );
  const direct = importing(modules.map(moduleName).join("|"));
  const testkits = direct.filter((path) => path.endsWith(".testkit.ts"));
  const viaTestkit = testkits.length === 0 ? [] : importing(testkits.map(moduleName).join("|"));
  if (!NodeFS.existsSync(NodePath.join(root, REPLAY_DIR)))
    throw new Error(
      `${REPLAY_DIR} is not in this checkout, so the replay suites for prompt text cannot run here.`,
    );
  const replay = NodeFS.readdirSync(NodePath.join(root, REPLAY_DIR))
    .filter((entry) => REPLAY_SUITE.test(entry))
    .map((entry) => NodePath.posix.join(REPLAY_DIR, entry));
  return [...direct, ...viaTestkit, ...replay].filter((path) => TEST.test(path));
}

/**
 * The coverage suite finds its files by walking src, so a component that starts bailing out of
 * React Compiler has no test beside it: #1483 passed its quick run and broke every full run until
 * #1491 (#1579). A deletion counts too, since mobile's suite fails when a file it lists as a known
 * bailout is gone.
 */
function compilerCoverageSuite(root: string, file: string): string | undefined {
  const app = APP_SOURCE.exec(file)?.[0];
  if (app === undefined || !COMPILED.test(file) || TEST.test(file)) return undefined;
  const suite = app + COVERAGE_SUITE;
  return NodeFS.existsSync(NodePath.join(root, suite)) ? suite : undefined;
}

/**
 * Changed test files, and the test files beside a changed source file
 * (foo.ts -> foo.test.ts, foo.browser.test.tsx). Vitest's import-graph
 * `related` reaches most of a package: one leaf server file pulled in 252 of
 * 406 server test files and took 7 minutes. CI runs the rest. Prompt text and an app's React
 * Compiler coverage suite are the exceptions; see promptTextTests and compilerCoverageSuite.
 *
 * `code` includes deleted files: they select no test beside them, but still select the suites
 * that read them through another path.
 *
 * Paths are git's repo-relative POSIX paths in and out on every platform, so Windows selects
 * the same suites as CI; NodePath.join would emit backslashes there.
 */
export function testsForChanges(root: string, code: ReadonlyArray<string>): ReadonlySet<string> {
  const present = code.filter((file) => NodeFS.existsSync(NodePath.join(root, file)));
  const tests = new Set(present.filter((file) => TEST.test(file)));
  for (const file of present) {
    const dir = NodePath.posix.dirname(file);
    const prefix = `${NodePath.posix.basename(file).replace(CODE, "")}.`;
    for (const entry of NodeFS.readdirSync(NodePath.join(root, dir))) {
      if (entry.startsWith(prefix) && TEST.test(entry)) tests.add(NodePath.posix.join(dir, entry));
    }
  }
  for (const file of code) {
    const suite = compilerCoverageSuite(root, file);
    if (suite !== undefined) tests.add(suite);
  }
  if (code.some((file) => PROMPT_TEXT.test(file) && !TEST.test(file)))
    for (const test of promptTextTests(root)) tests.add(test);
  return tests;
}
