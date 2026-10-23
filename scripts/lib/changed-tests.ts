// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const CODE = /\.[cm]?[jt]sx?$/;
const TEST = /\.test\.[cm]?[jt]sx?$/;

/** Text GOAT sends to providers: instruction sections, runtime notes, the memory frame. */
const PROMPT_TEXT =
  /^(?:packages\/provider-[^/]+\/src\/server|apps\/server\/src\/provider|apps\/server\/src\/orchestration-v2\/testkit)\/[^/]*(?:Instructions|memoryContext)\.ts$/;
const REPLAY_DIR = "apps/server/src/orchestration-v2/testkit";
const REPLAY_SUITE = /Replay.*\.integration\.test\.ts$/;

const git = (root: string, args: ReadonlyArray<string>) =>
  NodeChildProcess.spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
  })
    .stdout.split("\n")
    .filter(Boolean);

/**
 * Prompt text reaches recorded provider payloads through adapters and the replay harness, so the
 * suites that compare it are never beside it (#901). The modules compose each other, so a change
 * to one runs every replay suite and the tests that import any prompt module, directly or through
 * a testkit.
 */
function promptTextTests(root: string): ReadonlyArray<string> {
  const moduleName = (path: string) => NodePath.basename(path).replace(CODE, "");
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
  const replay = NodeFS.readdirSync(NodePath.join(root, REPLAY_DIR))
    .filter((entry) => REPLAY_SUITE.test(entry))
    .map((entry) => NodePath.join(REPLAY_DIR, entry));
  return [...direct, ...viaTestkit, ...replay].filter((path) => TEST.test(path));
}

/**
 * Changed test files, and the test files beside a changed source file
 * (foo.ts -> foo.test.ts, foo.browser.test.tsx). Vitest's import-graph
 * `related` reaches most of a package: one leaf server file pulled in 252 of
 * 406 server test files and took 7 minutes. CI runs the rest. Prompt text is the
 * exception; see promptTextTests.
 */
export function testsForChanges(root: string, code: ReadonlyArray<string>): ReadonlySet<string> {
  const tests = new Set(code.filter((file) => TEST.test(file)));
  for (const file of code) {
    const dir = NodePath.dirname(file);
    const prefix = `${NodePath.basename(file).replace(CODE, "")}.`;
    for (const entry of NodeFS.readdirSync(NodePath.join(root, dir))) {
      if (entry.startsWith(prefix) && TEST.test(entry)) tests.add(NodePath.join(dir, entry));
    }
  }
  if (code.some((file) => PROMPT_TEXT.test(file) && !TEST.test(file)))
    for (const test of promptTextTests(root)) tests.add(test);
  return tests;
}
