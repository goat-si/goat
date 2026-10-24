// @effect-diagnostics nodeBuiltinImport:off - a git wrapper that needs no installed dependencies.
// oxlint-disable goat/no-global-process-runtime -- A standalone CLI with no Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/**
 * `git worktree add` that also works from a submodule checkout. There the shared config sets
 * `core.worktree`, and with `extensions.worktreeConfig` on, a plain add leaves the new
 * worktree resolving to the git dir: post-checkout sees the wrong root and later commands see
 * the git dir's files. Like GOAT's own worktree creation (readWorktreeRoot and pinWorktreeRoot
 * in apps/server/src/vcs/worktreeCheckout.ts), this pins the new worktree's own
 * `core.worktree` before anything is checked out or any hook runs.
 */
const USAGE =
  "Usage: node scripts/worktree-add.ts <path> [git worktree add options] [<commit-ish>]";

class WorktreeAddError extends Error {}

/**
 * A git hook exports GIT_DIR, GIT_INDEX_FILE and friends for the checkout that ran it (#1114).
 * Inherited, they would point the commands below at that checkout instead of their cwd, so they
 * are dropped, using the list Git itself clears when it moves to another repository.
 */
const gitEnv = { ...process.env };
for (const name of NodeChildProcess.execFileSync("git", ["rev-parse", "--local-env-vars"], {
  encoding: "utf8",
}).split("\n")) {
  if (name !== "") delete gitEnv[name];
}

function git(cwd: string, args: ReadonlyArray<string>) {
  const result = NodeChildProcess.spawnSync("git", args, { cwd, env: gitEnv, encoding: "utf8" });
  if (result.error) throw result.error;
  return { ok: result.status === 0, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

function gitValue(cwd: string, args: ReadonlyArray<string>): string {
  const result = git(cwd, args);
  return result.ok ? result.stdout : "";
}

function gitRequired(cwd: string, args: ReadonlyArray<string>): string {
  const result = git(cwd, args);
  if (!result.ok) throw new WorktreeAddError(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout;
}

function gitVisible(cwd: string, args: ReadonlyArray<string>): void {
  const result = NodeChildProcess.spawnSync("git", args, { cwd, env: gitEnv, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new WorktreeAddError(`git ${args.join(" ")} failed`);
}

function comparablePath(target: string): string {
  let resolved = NodePath.resolve(target);
  try {
    resolved = NodeFS.realpathSync.native(resolved);
  } catch {}
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Same rules as readWorktreeRoot in apps/server/src/vcs/worktreeCheckout.ts. */
function readWorktreeRoot(cwd: string): { readonly pin: boolean; readonly checkoutApart: boolean } {
  const effective = gitValue(cwd, ["config", "--get-all", "core.worktree"]) !== "";
  const [gitDir = "", commonDir = ""] = gitRequired(cwd, [
    "rev-parse",
    "--absolute-git-dir",
    "--git-common-dir",
  ]).split("\n");
  const common = NodePath.resolve(cwd, commonDir);
  const rootIn = (file: string) =>
    gitValue(cwd, ["config", "--file", NodePath.join(common, file), "--get", "core.worktree"]) !==
    "";
  if (!effective) {
    // A linked checkout does not read the main worktree's config.worktree.
    const linked = comparablePath(common) !== comparablePath(gitDir);
    return { pin: linked && rootIn("config.worktree"), checkoutApart: false };
  }
  const checkoutApart =
    rootIn("config") &&
    gitValue(cwd, ["config", "--bool", "--get", "extensions.worktreeConfig"]) === "true";
  return { pin: true, checkoutApart };
}

/**
 * Writes the worktree's own config.worktree by file name: `git config --worktree` writes the
 * shared config while extensions.worktreeConfig is off, which would move the original
 * checkout's root.
 */
function pinWorktreeRoot(worktree: string): void {
  const gitDir = gitRequired(worktree, ["rev-parse", "--absolute-git-dir"]);
  gitRequired(worktree, [
    "config",
    "--file",
    NodePath.join(gitDir, "config.worktree"),
    "core.worktree",
    worktree,
  ]);
  const root = gitRequired(worktree, ["rev-parse", "--show-toplevel"]);
  if (comparablePath(root) !== comparablePath(worktree)) {
    throw new WorktreeAddError(
      `${worktree} resolves to ${root}; check core.worktree in ${gitDir}/config.worktree`,
    );
  }
}

function run(cwd: string, args: ReadonlyArray<string>): void {
  const [target, ...rest] = args;
  if (target === undefined || target.startsWith("-")) throw new WorktreeAddError(USAGE);
  // This script decides when the checkout happens. Every spelling of --checkout or --no-checkout,
  // abbreviations included, starts with one of these; a lookalike option value is refused too.
  if (rest.some((arg) => arg.startsWith("--c") || arg.startsWith("--no-c"))) {
    throw new WorktreeAddError("This script always checks out; drop --checkout and --no-checkout.");
  }
  const worktree = NodePath.resolve(cwd, target);
  const root = readWorktreeRoot(cwd);
  if (!root.checkoutApart) {
    gitVisible(cwd, ["worktree", "add", worktree, ...rest]);
    if (root.pin) pinWorktreeRoot(worktree);
    return;
  }
  // -h prints usage and exits 129 where `git hook run` exists (Git 2.36+).
  if (
    NodeChildProcess.spawnSync("git", ["hook", "run", "-h"], { cwd, env: gitEnv, stdio: "ignore" })
      .status !== 129
  ) {
    throw new WorktreeAddError("Creating a worktree from this checkout needs Git 2.36 or later.");
  }
  const hooks = NodePath.resolve(cwd, gitRequired(cwd, ["rev-parse", "--git-path", "hooks"]));
  // First, so no caller option can take it as its value.
  gitVisible(cwd, ["worktree", "add", "--no-checkout", worktree, ...rest]);
  try {
    pinWorktreeRoot(worktree);
    // Hooks stay off for checkout, which would report a same-commit switch; post-checkout then
    // runs with the all-zero previous HEAD that marks a new worktree.
    gitVisible(worktree, [
      "-c",
      `core.hooksPath=${NodePath.join(worktree, ".git-goat-no-hooks")}`,
      "checkout",
      "-f",
    ]);
    const head = gitRequired(worktree, ["rev-parse", "HEAD"]);
    gitVisible(worktree, [
      "-c",
      `core.hooksPath=${hooks}`,
      "hook",
      "run",
      "--ignore-missing",
      "post-checkout",
      "--",
      "0".repeat(head.length),
      head,
      "1",
    ]);
  } catch (error) {
    if (error instanceof WorktreeAddError) {
      error.message += `\nRemove the partial worktree with: git worktree remove --force --force ${worktree}`;
    }
    throw error;
  }
}

try {
  run(process.cwd(), process.argv.slice(2));
} catch (error) {
  process.stderr.write(`worktree-add: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = error instanceof WorktreeAddError && error.message === USAGE ? 2 : 1;
}
