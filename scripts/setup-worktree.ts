// @effect-diagnostics nodeBuiltinImport:off - runs before `vp i`, so only Node built-ins exist.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { currentUnsupportedNodeMessage, readPinnedNodeVersion } from "./lib/node-runtime.ts";

const ENV_FILES = [".env", NodePath.join("infra", "relay", ".env")];

const worktree = NodePath.dirname(import.meta.dirname);

/** Set for the setup this one starts under the pinned Node, so it never starts a third. */
const PINNED_NODE_RERUN = "GOAT_SETUP_PINNED_NODE";
/**
 * One file per rerun, named by a token only its starter knows: the starter writes "requested",
 * the rerun "started" and then how it ended. The starter owns the markers agents read.
 */
const RERUN_FILE_PREFIX = "setup-rerun-";

export function pinnedNodeRunners(input: {
  readonly pinned: string;
  readonly vp: boolean;
  readonly autoDownload: boolean;
}): { readonly command: string; readonly tool: string }[] {
  return input.vp && input.autoDownload
    ? [
        {
          command: `vp env exec --node ${input.pinned} -- node scripts/setup-worktree.ts`,
          tool: "vp",
        },
      ]
    : [];
}

export function worktreeInstallCandidates(tools: {
  readonly vp: boolean;
  readonly pnpm: boolean;
}): { readonly command: string; readonly tool: string }[] {
  return [
    ...(tools.vp ? [{ command: "vp i --frozen-lockfile", tool: "vp" }] : []),
    ...(tools.pnpm ? [{ command: "pnpm install --frozen-lockfile", tool: "pnpm" }] : []),
  ];
}

// The 0.2.2 floor adds signed checksums; see docs/operations/development.md#worktrees.
export function vpSupportsVerifiedNodeDownload(
  timeout = 5_000,
  command = "vp",
): { supported: boolean; timedOut: boolean } {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-vp-version-"));
  const output = NodePath.join(directory, "stdout");
  let fd: number | undefined;
  try {
    fd = NodeFS.openSync(output, "wx+");
    // Windows needs a shell for command shims; POSIX uses a group to clean up descendants.
    // oxlint-disable-next-line goat/no-global-process-runtime -- Setup runs before dependencies are installed.
    const windows = process.platform === "win32";
    const options: NodeChildProcess.SpawnSyncOptions & { detached: boolean } = {
      shell: windows,
      detached: !windows,
      stdio: ["ignore", fd, "ignore"],
      timeout,
      killSignal: "SIGKILL",
    };
    const result = NodeChildProcess.spawnSync(command, ["--version"], options);
    const timedOut =
      result.error !== undefined && "code" in result.error && result.error.code === "ETIMEDOUT";
    if (timedOut && !windows && result.pid) {
      try {
        process.kill(-result.pid, "SIGKILL");
      } catch {
        // The process group has already exited.
      }
    }
    const stdout = NodeFS.readFileSync(output, "utf8");
    const match = /^vp v(\d+)\.(\d+)\.(\d+)\s*$/.exec(stdout.split(/\r?\n/, 1)[0] ?? "");
    if (result.error || result.status !== 0 || !match) return { supported: false, timedOut };
    const [, major = "0", minor = "0", patch = "0"] = match;
    return {
      supported:
        Number(major) > 0 || Number(minor) > 2 || (Number(minor) === 2 && Number(patch) >= 2),
      timedOut,
    };
  } finally {
    try {
      if (fd !== undefined) NodeFS.closeSync(fd);
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  }
}

/** The pnpm release root package.json names, for the message when no installer can run. */
function pinnedPackageManager(): string {
  const manifest: { readonly packageManager?: unknown } = JSON.parse(
    NodeFS.readFileSync(NodePath.join(worktree, "package.json"), "utf8"),
  );
  return typeof manifest.packageManager === "string"
    ? manifest.packageManager.replace("@", " ")
    : "pnpm";
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
  // A rerun writes no marker: the setup that started it stays the live setup-running process.
  // The flag alone does not make a rerun; its starter's request file must be there too.
  const rerunToken = process.env[PINNED_NODE_RERUN];
  const requestedFile =
    rerunToken !== undefined && /^[0-9a-f-]{36}$/.test(rerunToken)
      ? NodePath.join(markerDir, `${RERUN_FILE_PREFIX}${rerunToken}`)
      : undefined;
  const rerunFile =
    requestedFile !== undefined &&
    NodeFS.existsSync(requestedFile) &&
    NodeFS.readFileSync(requestedFile, "utf8") === "requested\n"
      ? requestedFile
      : undefined;
  const isRerun = rerunFile !== undefined;
  createMarkerDirectory(markerDir);
  if (rerunFile !== undefined) NodeFS.writeFileSync(rerunFile, "started\n");
  else {
    NodeFS.rmSync(doneMarker, { force: true });
    NodeFS.rmSync(failedMarker, { force: true });
    NodeFS.writeFileSync(runningMarker, `${process.pid}\n`);
  }
  let failureDetail = "";
  let rerunFoundUnsupportedNode = false;
  process.on("uncaughtExceptionMonitor", (error) => {
    failureDetail = error.stack ?? String(error);
  });
  process.on("exit", (code) => {
    if (rerunFile !== undefined) {
      const outcome =
        code === 0
          ? "done\n"
          : rerunFoundUnsupportedNode
            ? "unsupported-node\n"
            : `failed\n${failureDetail}\n`;
      // Renamed into place, so the starter never reads a half-written outcome.
      NodeFS.writeFileSync(`${rerunFile}.tmp`, outcome);
      NodeFS.renameSync(`${rerunFile}.tmp`, rerunFile);
      return;
    }
    if (code === 0) NodeFS.writeFileSync(doneMarker, "");
    else {
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
    const autoDownload = process.env.GOAT_SETUP_NO_NODE_DOWNLOAD !== "1";
    // Windows has no process group to cancel a rerun through, so it keeps refusing.
    // oxlint-disable-next-line goat/no-global-process-runtime -- Setup runs before dependencies are installed.
    const hasVp = autoDownload && !isRerun && process.platform !== "win32" && toolOnPath("vp");
    const probe = hasVp ? vpSupportsVerifiedNodeDownload() : undefined;
    const signatureBypassed = Boolean(process.env.VP_NODE_SKIP_SIGNATURE_VERIFY);
    const verifiedVp = (probe?.supported ?? false) && !signatureBypassed;
    const runners = pinnedNodeRunners({ pinned, vp: verifiedVp, autoDownload });
    const tried: string[] = [];
    for (const runner of runners) {
      process.stderr.write(
        `Worktree setup: Node.js ${process.versions.node} is not the pinned ${pinned}; running setup under it with ${runner.tool}.\n`,
      );
      const token = NodeCrypto.randomUUID();
      const requestFile = NodePath.join(markerDir, `${RERUN_FILE_PREFIX}${token}`);
      NodeFS.writeFileSync(requestFile, "requested\n");
      const rerun = NodeChildProcess.spawn(runner.command, {
        cwd: worktree,
        shell: true,
        // Its own group, so a cancel reaches the runner and the setup under it, not only the shell.
        detached: true,
        // Piped, so `close` waits for every process the runner started, as the install below does.
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, [PINNED_NODE_RERUN]: token },
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
      // What the rerun itself says happened; a runner's exit code alone cannot tell these apart.
      const outcome = NodeFS.existsSync(requestFile)
        ? NodeFS.readFileSync(requestFile, "utf8")
        : "requested\n";
      NodeFS.rmSync(requestFile, { force: true });
      NodeFS.rmSync(`${requestFile}.tmp`, { force: true });
      const tail = rerunOutput.trimEnd().split("\n").slice(-10).join("\n") || "no output";
      if (cancelSignal) {
        failureDetail = `Cancelled by ${cancelSignal}.`;
        process.exit(status || 1);
      }
      if (outcome === "done\n" && status === 0) process.exit(0);
      if (outcome === "done\n") {
        failureDetail = `${runner.tool} exited with ${status ?? "a signal"} after setup finished.\n${tail}`;
        process.exit(status || 1);
      }
      if (outcome.startsWith("failed\n")) {
        failureDetail = outcome.slice("failed\n".length).trimEnd();
        process.exit(status || 1);
      }
      if (outcome !== "requested\n" && outcome !== "unsupported-node\n") {
        // It started and never said how it ended: killed, crashed, or its outcome was not
        // written. Whatever it left running is stopped before the end marker is published.
        signalProcessGroup(rerun, "SIGKILL");
        failureDetail = `Setup under ${runner.tool} ended without finishing.\n${tail}`;
        process.exit(status || 1);
      }
      tried.push(
        outcome === "unsupported-node\n"
          ? `${runner.tool}: it ran setup under a Node.js that is not ${pinned}`
          : `${runner.tool}: ${tail}`,
      );
    }
    const reason = !autoDownload
      ? "GOAT_SETUP_NO_NODE_DOWNLOAD=1 prevents setup from downloading Node."
      : hasVp && signatureBypassed
        ? "VP_NODE_SKIP_SIGNATURE_VERIFY disables signature verification; unset it before setup downloads Node."
        : hasVp && !verifiedVp
          ? `${probe?.timedOut ? "vp did not answer its version probe. " : ""}Update vite-plus to 0.2.2 or later to enable verified Node downloads.`
          : "";
    failureDetail = [
      unsupportedNode,
      reason,
      `Install Node.js ${pinned} (or a later ${pinned.split(".")[0]}.x) from nodejs.org, fnm, volta, or run vp env install ${pinned}; then run node scripts/setup-worktree.ts again.`,
      ...(tried.length
        ? [`Setup could not start itself under Node.js ${pinned}. Tried:\n${tried.join("\n")}`]
        : []),
    ]
      .filter(Boolean)
      .join("\n");
    process.stderr.write(`${failureDetail}\n`);
    rerunFoundUnsupportedNode = true;
    process.exit(1);
  }

  // GOAT passes the project root, older builds under its legacy T3 name. The git
  // hook passes neither; the main worktree is the first `git worktree list` entry.
  const projectRoot =
    process.env.GOAT_PROJECT_ROOT || process.env.T3CODE_PROJECT_ROOT || mainWorktree(); // goat-rename: legacy

  const candidates = worktreeInstallCandidates({ vp: toolOnPath("vp"), pnpm: toolOnPath("pnpm") });
  const installerGuidance = `Install vite-plus (see README, Getting started) or ${pinnedPackageManager()}, then run node scripts/setup-worktree.ts again.`;
  if (candidates.length === 0) {
    failureDetail = `No installer: vp and pnpm are not on PATH. ${installerGuidance}`;
    process.stderr.write(`${failureDetail}\n`);
    process.exit(1);
  }
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
      : launcherMissing
        ? `pnpm on PATH is a Corepack shim whose launcher is missing. ${installerGuidance}`
        : installOutput.trimEnd().split("\n").slice(-30).join("\n");
    if (launcherMissing && !cancelSignal) process.stderr.write(`${failureDetail}\n`);
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
