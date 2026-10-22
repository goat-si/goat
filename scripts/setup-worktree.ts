// @effect-diagnostics nodeBuiltinImport:off - runs before `vp i`, so only Node built-ins exist.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const ENV_FILES = [".env", NodePath.join("infra", "relay", ".env")];

const worktree = NodePath.dirname(import.meta.dirname);

export function selectWorktreeInstall(tools: { readonly vp: boolean; readonly pnpm: boolean }): {
  readonly command: string;
  readonly tool: string;
} {
  if (tools.vp) return { command: "vp i --frozen-lockfile -- --yes", tool: "vp" };
  if (tools.pnpm) return { command: "pnpm install --frozen-lockfile", tool: "pnpm" };
  return { command: "npx --yes vite-plus i --frozen-lockfile -- --yes", tool: "npx vite-plus" };
}

function toolOnPath(name: string): boolean {
  // oxlint-disable-next-line goat/no-global-process-runtime -- Runs before `vp i`, with no Effect runtime.
  const locator = process.platform === "win32" ? "where" : "command -v";
  const result = NodeChildProcess.spawnSync(`${locator} ${name}`, {
    shell: true,
    stdio: "ignore",
  });
  return result.status === 0;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return (
      NodeFS.realpathSync(NodePath.resolve(entry)) ===
      NodeFS.realpathSync(NodeURL.fileURLToPath(import.meta.url))
    );
  } catch {
    return NodePath.resolve(entry) === NodeURL.fileURLToPath(import.meta.url);
  }
}

function main(): void {
  // GOAT passes the project root, older builds under its legacy T3 name. The git
  // hook passes neither; the main worktree is the first `git worktree list` entry.
  const projectRoot =
    process.env.GOAT_PROJECT_ROOT || process.env.T3CODE_PROJECT_ROOT || mainWorktree(); // goat-rename: legacy

  // A fresh worktree has no node_modules and often no global `vp`.
  const selected = selectWorktreeInstall({
    vp: toolOnPath("vp"),
    pnpm: toolOnPath("pnpm"),
  });
  process.stderr.write(`Worktree setup: installing dependencies with ${selected.tool}.\n`);
  // `shell` resolves the tool through PATH, including Windows command shims.
  // Setup has no one answering install prompts. Pass pnpm's confirmation flag
  // through vp and leave stdin closed so other prompts fail instead of hanging.
  // Install exactly the locked dependencies so setup never rewrites the lockfile.
  const install = NodeChildProcess.spawnSync(selected.command, {
    cwd: worktree,
    shell: true,
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (install.status !== 0) process.exit(install.status ?? 1);

  // Env files live as real files in the main checkout; worktrees only get
  // symlinks to them. Only a symlink is ever replaced, so a real env file is
  // never deleted, including when this runs in the main checkout itself.
  for (const file of ENV_FILES) {
    const source = NodePath.join(projectRoot, file);
    const sourceStat = NodeFS.lstatSync(source, { throwIfNoEntry: false });
    if (!sourceStat) continue;
    if (!sourceStat.isFile()) {
      process.stderr.write(`Skipping ${file}: ${source} is not a regular file.\n`);
      continue;
    }
    const target = NodePath.join(worktree, file);
    const existing = NodeFS.lstatSync(target, { throwIfNoEntry: false });
    if (existing && !existing.isSymbolicLink()) continue;
    if (existing) NodeFS.rmSync(target);
    NodeFS.symlinkSync(source, target);
  }

  const warm = NodeChildProcess.spawnSync(
    process.execPath,
    [NodePath.join(worktree, "apps", "web", "scripts", "warm-dep-cache.ts")],
    { cwd: worktree, stdio: "inherit" },
  );
  process.exit(warm.status ?? 1);
}

function mainWorktree(): string {
  const list = NodeChildProcess.execFileSync("git", ["worktree", "list", "--porcelain"], {
    cwd: worktree,
    encoding: "utf8",
  });
  const first = list.split("\n", 1)[0] ?? "";
  if (!first.startsWith("worktree ")) {
    throw new Error("Could not find the main worktree in `git worktree list --porcelain`.");
  }
  return first.slice("worktree ".length);
}

if (isDirectRun()) main();
