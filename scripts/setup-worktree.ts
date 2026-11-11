// @effect-diagnostics nodeBuiltinImport:off - runs before `vp i`, so only Node built-ins exist.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { currentUnsupportedNodeMessage, readPinnedNodeVersion } from "./lib/node-runtime.ts";

const ENV_FILES = [".env", NodePath.join("infra", "relay", ".env")];

const worktree = NodePath.dirname(import.meta.dirname);

/** Set for the setup this one starts under the pinned Node, so it never starts a third. */
const PINNED_NODE_RERUN = "GOAT_SETUP_PINNED_NODE";
/** A rerun that still found an unsupported Node: its runner did not supply the pin. */
const RERUN_UNSUPPORTED_NODE_EXIT = 3;

/**
 * Ways to run setup again under the pinned Node when PATH's Node is another release.
 * `vp env` exists only in the global vp, so a machine without it gets Node from npm.
 */
export function pinnedNodeRunners(input: {
  readonly pinned: string;
  readonly vp: boolean;
  readonly npx: boolean;
}): {
  readonly command: string;
  readonly tool: string;
}[] {
  const setup = "node scripts/setup-worktree.ts";
  return [
    ...(input.vp
      ? [{ command: `vp env exec --node ${input.pinned} -- ${setup}`, tool: "vp" }]
      : []),
    ...(input.npx
      ? [
          {
            command: `npx --yes --package=node@${input.pinned} -- ${setup}`,
            tool: `npx node@${input.pinned}`,
          },
        ]
      : []),
  ];
}

/** The vite-plus release pnpm-workspace.yaml pins, so npx runs that one and not the latest. */
export function pinnedVitePlusVersion(workspaceYaml: string): string | undefined {
  return /^ {2}vite-plus: (\d+\.\d+\.\d+)\s*$/m.exec(workspaceYaml)?.[1];
}

export function worktreeInstallCandidates(tools: {
  readonly vp: boolean;
  readonly pnpm: boolean;
  readonly vitePlusVersion?: string | undefined;
}): {
  readonly command: string;
  readonly tool: string;
}[] {
  return [
    ...(tools.vp ? [{ command: "vp i --frozen-lockfile", tool: "vp" }] : []),
    ...(tools.pnpm ? [{ command: "pnpm install --frozen-lockfile", tool: "pnpm" }] : []),
    {
      // The package's executables are vp, vpr and vpx, so npx has to be told which to run.
      command: `npx --yes --package=vite-plus${tools.vitePlusVersion === undefined ? "" : `@${tools.vitePlusVersion}`} -- vp i --frozen-lockfile`,
      tool: "npx vite-plus",
    },
  ];
}

export function isCorepackLauncherMissing(output: string): boolean {
  return /Cannot find module\s+['"][^'"\r\n]*[\\/]corepack[\\/][^'"\r\n]*[\\/]bin[\\/]pnpm\.cjs['"]/i.test(
    output,
  );
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

/** Signals the group a detached child leads, so everything it started gets the signal. */
function signalProcessGroup(child: NodeChildProcess.ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The group is already gone; fall through to the child itself.
    }
  }
  child.kill(signal);
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

/**
 * Without group or other access even under umask 002: the dev server keeps the
 * modes it finds here, and its memory import rejects writable state (#1648).
 */
export function createMarkerDirectory(directory: string): void {
  NodeFS.mkdirSync(directory, { recursive: true, mode: 0o700 });
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
  createMarkerDirectory(markerDir);
  NodeFS.writeFileSync(runningMarker, `${process.pid}\n`);
  let failureDetail = "";
  process.on("uncaughtExceptionMonitor", (error) => {
    failureDetail = error.stack ?? String(error);
  });
  process.on("exit", (code) => {
    if (code === 0) NodeFS.writeFileSync(doneMarker, "");
    else {
      // A cancelled rerun may have finished first; only one end marker may remain.
      NodeFS.rmSync(doneMarker, { force: true });
      NodeFS.writeFileSync(failedMarker, `Setup exited with code ${code}.\n${failureDetail}\n`);
    }
    NodeFS.rmSync(runningMarker, { force: true });
  });
  // A cancelled setup must still leave a marker, or agents would wait forever.
  // During install, the signal goes on to the installer and setup exits when the
  // install output closes. Any child the shell leaves behind holds that output
  // open, so no marker appears while the installer can still write node_modules.
  let cancelSignal: NodeJS.Signals | undefined;
  let activeInstall: NodeChildProcess.ChildProcess | undefined;
  let activeRerun: NodeChildProcess.ChildProcess | undefined;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      cancelSignal = signal;
      if (activeRerun) signalProcessGroup(activeRerun, signal);
      else if (activeInstall) activeInstall.kill(signal);
      else process.exit(1);
    });
  }

  const unsupportedNode = currentUnsupportedNodeMessage("node scripts/setup-worktree.ts");
  if (unsupportedNode) {
    // A machine that only has another Node, such as a fresh cloud VM, still sets up:
    // the same script runs once more under the pinned release and owns the markers.
    const pinned = readPinnedNodeVersion();
    const runners =
      // Windows has no process group to cancel a rerun through, so it keeps refusing.
      // oxlint-disable-next-line goat/no-global-process-runtime -- Runs before `vp i`, with no Effect runtime.
      process.env[PINNED_NODE_RERUN] === "1" || process.platform === "win32"
        ? []
        : pinnedNodeRunners({ pinned, vp: toolOnPath("vp"), npx: toolOnPath("npx") });
    const tried: string[] = [];
    for (const runner of runners) {
      process.stderr.write(
        `Worktree setup: Node.js ${process.versions.node} is not the pinned ${pinned}; running setup under it with ${runner.tool}.\n`,
      );
      const rerun = NodeChildProcess.spawn(runner.command, {
        cwd: worktree,
        shell: true,
        // Its own group, so a cancel reaches the runner and the setup under it, not only the shell.
        detached: true,
        // Piped, so `close` waits for every process the runner started, as the install below does.
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, [PINNED_NODE_RERUN]: "1" },
      });
      activeRerun = rerun;
      let rerunOutput = "";
      for (const [source, target] of [
        [rerun.stdout, process.stdout],
        [rerun.stderr, process.stderr],
      ] as const) {
        source.setEncoding("utf8");
        source.on("data", (chunk: string) => {
          target.write(chunk);
          rerunOutput = (rerunOutput + chunk).slice(-8_000);
        });
      }
      const status = await new Promise<number | null>((resolve) => rerun.on("close", resolve));
      activeRerun = undefined;
      // The rerun leaves setup-done or setup-failed; neither means the runner never started it.
      if (status === 0 && !cancelSignal && NodeFS.existsSync(doneMarker)) process.exit(0);
      if (status === RERUN_UNSUPPORTED_NODE_EXIT && !cancelSignal) {
        // The runner started setup under a Node that is still not the pin; the next may do better.
        NodeFS.rmSync(failedMarker, { force: true });
        NodeFS.writeFileSync(runningMarker, `${process.pid}\n`);
        tried.push(`${runner.tool}: it ran setup under a Node.js that is not ${pinned}`);
        continue;
      }
      const rerunFailure = NodeFS.existsSync(failedMarker)
        ? NodeFS.readFileSync(failedMarker, "utf8").split("\n").slice(1).join("\n").trimEnd()
        : undefined;
      if (cancelSignal || rerunFailure !== undefined) {
        failureDetail = cancelSignal ? `Cancelled by ${cancelSignal}.` : (rerunFailure ?? "");
        process.exit(status || 1);
      }
      // Agents wait on this marker; the runner's own exit must not look like no setup.
      NodeFS.writeFileSync(runningMarker, `${process.pid}\n`);
      tried.push(
        `${runner.tool}: ${rerunOutput.trimEnd().split("\n").slice(-10).join("\n") || "no output"}`,
      );
    }
    failureDetail =
      tried.length === 0
        ? unsupportedNode
        : `${unsupportedNode}\nSetup could not start itself under Node.js ${pinned}. Tried:\n${tried.join("\n")}`;
    process.stderr.write(`${failureDetail}\n`);
    process.exit(process.env[PINNED_NODE_RERUN] === "1" ? RERUN_UNSUPPORTED_NODE_EXIT : 1);
  }

  // GOAT passes the project root, older builds under its legacy T3 name. The git
  // hook passes neither; the main worktree is the first `git worktree list` entry.
  const projectRoot =
    process.env.GOAT_PROJECT_ROOT || process.env.T3CODE_PROJECT_ROOT || mainWorktree(); // goat-rename: legacy

  // A fresh worktree has no node_modules and often no global `vp`.
  const workspaceYaml = NodePath.join(worktree, "pnpm-workspace.yaml");
  const candidates = worktreeInstallCandidates({
    vp: toolOnPath("vp"),
    pnpm: toolOnPath("pnpm"),
    vitePlusVersion: NodeFS.existsSync(workspaceYaml)
      ? pinnedVitePlusVersion(NodeFS.readFileSync(workspaceYaml, "utf8"))
      : undefined,
  });
  // Shell resolves Windows shims; closed stdin prevents unattended prompts.
  // pnpm 12 builds can reject --yes, and the frozen lockfile prevents rewrites.
  // Capture output so the failure marker can include its tail.
  for (const [index, selected] of candidates.entries()) {
    process.stderr.write(`Worktree setup: installing dependencies with ${selected.tool}.\n`);
    const install = NodeChildProcess.spawn(selected.command, {
      cwd: worktree,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeInstall = install;
    let installOutput = "";
    let launcherMissing = false;
    for (const [source, target] of [
      [install.stdout, process.stdout],
      [install.stderr, process.stderr],
    ] as const) {
      // The tail kept for the marker can drop the diagnostic, so it is matched as output arrives.
      let carry = "";
      source.setEncoding("utf8");
      source.on("data", (chunk: string) => {
        target.write(chunk);
        installOutput = (installOutput + chunk).slice(-8_000);
        launcherMissing ||= isCorepackLauncherMissing(carry + chunk);
        carry = (carry + chunk).slice(-1_000);
      });
    }
    const installStatus = await new Promise<number | null>((resolve) =>
      install.on("close", resolve),
    );
    activeInstall = undefined;
    if (installStatus === 0 && !cancelSignal) break;
    if (!cancelSignal && index + 1 < candidates.length && launcherMissing) {
      process.stderr.write(
        "Worktree setup: corepack's pnpm launcher is missing; trying the next installer.\n",
      );
      continue;
    }
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
