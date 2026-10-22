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

async function main(): Promise<void> {
  // Setup can run in the background, so agents can start before it ends.
  // `setup-running` holds this PID until setup ends with `setup-done` or
  // `setup-failed`, so agents wait instead of racing it with their own `vp i`.
  const markerDir = NodePath.join(worktree, ".goat");
  const runningMarker = NodePath.join(markerDir, "setup-running");
  const doneMarker = NodePath.join(markerDir, "setup-done");
  const failedMarker = NodePath.join(markerDir, "setup-failed");
  NodeFS.rmSync(doneMarker, { force: true });
  NodeFS.rmSync(failedMarker, { force: true });
  NodeFS.mkdirSync(markerDir, { recursive: true });
  NodeFS.writeFileSync(runningMarker, `${process.pid}\n`);
  let failureDetail = "";
  process.on("uncaughtExceptionMonitor", (error) => {
    failureDetail = error.stack ?? String(error);
  });
  process.on("exit", (code) => {
    if (code === 0) NodeFS.writeFileSync(doneMarker, "");
    else NodeFS.writeFileSync(failedMarker, `Setup exited with code ${code}.\n${failureDetail}\n`);
    NodeFS.rmSync(runningMarker, { force: true });
  });
  // A cancelled setup must still leave a marker, or agents would wait forever.
  // During install, the signal goes on to the installer and setup exits when the
  // install output closes. Any child the shell leaves behind holds that output
  // open, so no marker appears while the installer can still write node_modules.
  let cancelSignal: NodeJS.Signals | undefined;
  let activeInstall: NodeChildProcess.ChildProcess | undefined;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      cancelSignal = signal;
      if (activeInstall) activeInstall.kill(signal);
      else process.exit(1);
    });
  }

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
  // Output is piped, not inherited, so a failure can keep its tail in the marker.
  const install = NodeChildProcess.spawn(selected.command, {
    cwd: worktree,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  activeInstall = install;
  let installOutput = "";
  for (const [source, target] of [
    [install.stdout, process.stdout],
    [install.stderr, process.stderr],
  ] as const) {
    source.setEncoding("utf8");
    source.on("data", (chunk: string) => {
      target.write(chunk);
      installOutput = (installOutput + chunk).slice(-8_000);
    });
  }
  const installStatus = await new Promise<number | null>((resolve) => install.on("close", resolve));
  activeInstall = undefined;
  if (installStatus !== 0 || cancelSignal) {
    failureDetail = cancelSignal
      ? `Cancelled by ${cancelSignal}.`
      : installOutput.trimEnd().split("\n").slice(-30).join("\n");
    process.exit(installStatus || 1);
  }

  warnOnCrossDeviceStore();

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
}

// pnpm cannot clone or hardlink across filesystems, so a store on another
// device silently turns every worktree install into a full copy.
function warnOnCrossDeviceStore(): void {
  const modulesYaml = NodePath.join(worktree, "node_modules", ".modules.yaml");
  if (!NodeFS.existsSync(modulesYaml)) return;
  const storeDir: unknown = JSON.parse(NodeFS.readFileSync(modulesYaml, "utf8")).storeDir;
  if (
    typeof storeDir !== "string" ||
    NodeFS.statSync(storeDir).dev === NodeFS.statSync(NodePath.join(worktree, "node_modules")).dev
  )
    return;
  process.stderr.write(
    [
      "",
      "WARNING: the pnpm store is on a different filesystem than this worktree.",
      `  store:    ${storeDir}`,
      `  worktree: ${worktree}`,
      "pnpm cannot hardlink or clone across filesystems, so it copied every package into node_modules.",
      "Fix: put the store on the worktree's filesystem, for example:",
      `  pnpm config set store-dir ${JSON.stringify(NodePath.join(NodePath.dirname(worktree), ".pnpm-store"))} --global`,
      "",
      "",
    ].join("\n"),
  );
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

if (isDirectRun()) await main();
