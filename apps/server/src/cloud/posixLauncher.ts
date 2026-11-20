// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- The standalone launcher shares these Node-only operations.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { guardChild } from "@goat/shared/errorGuards";

const CAPABILITY_TIMEOUT_MS = 2_000;
const CAPABILITY_MAX_BYTES = 4_096;
const LAUNCHER_MAX_BYTES = 4_096;
const LAUNCHER_CANDIDATE_LIMIT = 256;
const LAUNCHER_RECORDS_MAX_BYTES = 65_536;
const LAUNCHER_PATH_MAX_CHARS = 65_536;

const posixLauncherScript = (executable: string) =>
  `#!/bin/sh\nexec '${executable.replaceAll("'", "'\\''")}' "$@"\n`;

async function readBounded(file: string, limit: number): Promise<string | undefined> {
  const handle = await NodeFSP.open(file, "r");
  try {
    const buffer = Buffer.alloc(limit + 1);
    let count = 0;
    while (count < buffer.length) {
      const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count);
      if (bytesRead === 0) break;
      count += bytesRead;
    }
    return count > limit ? undefined : buffer.subarray(0, count).toString("utf8");
  } finally {
    await handle.close();
  }
}

export async function readPosixLauncherTarget(
  launcher: string,
  strict = false,
): Promise<string | undefined> {
  try {
    const info = await NodeFSP.lstat(launcher);
    if (strict && info.isFile() && (info.mode & 0o444) === 0)
      throw new Error("Launcher is unreadable.");
    if (!info.isFile() || (info.mode & 0o111) === 0 || info.size > LAUNCHER_MAX_BYTES)
      return undefined;
    const contents = await readBounded(launcher, LAUNCHER_MAX_BYTES);
    if (contents === undefined) return undefined;
    const quoted = /^#!\/bin\/sh\nexec '((?:[^']|'\\'')*)' "\$@"\n$/.exec(contents)?.[1];
    if (quoted === undefined) return undefined;
    const target = quoted.replaceAll("'\\''", "'");
    return NodePath.isAbsolute(target) && posixLauncherScript(target) === contents
      ? target
      : undefined;
  } catch (error) {
    if (strict && !(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
    return undefined;
  }
}

const insideVersions = (versionsDir: string, target: string) => {
  const relative = NodePath.relative(versionsDir, NodePath.resolve(target));
  const parts = relative.split(NodePath.sep);
  return parts.length === 2 && parts[0] !== "" && parts[0] !== ".." && parts[1] === "goat";
};

export async function posixLauncherTarget(launcher: string): Promise<string | undefined> {
  try {
    const info = await NodeFSP.lstat(launcher);
    if (info.isSymbolicLink())
      return NodePath.resolve(NodePath.dirname(launcher), await NodeFSP.readlink(launcher));
    return await readPosixLauncherTarget(launcher);
  } catch {
    return undefined;
  }
}

export async function findPosixLauncher(input: {
  readonly launchedAs: string;
  readonly versionsDir: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly home: string;
}): Promise<string | undefined> {
  const realVersions = await NodeFSP.realpath(input.versionsDir).catch(() => input.versionsDir);
  const owns = (target: string) =>
    insideVersions(input.versionsDir, target) || insideVersions(realVersions, target);
  const ownsResolved = async (target: string) => {
    const real = await NodeFSP.realpath(target).catch(() => undefined);
    return real === undefined
      ? insideVersions(input.versionsDir, target)
      : insideVersions(realVersions, real);
  };
  const direct = await posixLauncherTarget(input.launchedAs);
  if (direct !== undefined && (await ownsResolved(direct))) return input.launchedAs;
  if (direct !== undefined) {
    const scriptTarget = await readPosixLauncherTarget(direct);
    if (scriptTarget !== undefined && (await ownsResolved(scriptTarget))) return direct;
  }
  const executable = await NodeFSP.realpath(input.launchedAs).catch(() => undefined);
  if (executable === undefined || !owns(executable)) return undefined;
  let recorded = "";
  const records = NodePath.join(NodePath.dirname(NodePath.dirname(input.versionsDir)), "launchers");
  try {
    recorded = (await readBounded(records, LAUNCHER_RECORDS_MAX_BYTES)) ?? "";
  } catch {}
  const candidates = [
    ...(input.environment.PATH ?? "")
      .slice(0, LAUNCHER_PATH_MAX_CHARS)
      .split(":")
      .filter(Boolean)
      .map((directory) => NodePath.resolve(input.cwd, directory, "goat")),
    NodePath.join(
      input.environment.GOAT_INSTALL_BIN_DIR || NodePath.join(input.home, ".local/bin"),
      "goat",
    ),
    ...recorded.split(/\r?\n/u).filter(Boolean),
  ].slice(0, LAUNCHER_CANDIDATE_LIMIT);
  for (const candidate of candidates) {
    if (!NodePath.isAbsolute(candidate)) continue;
    const script = await NodeFSP.realpath(candidate).catch(() => undefined);
    if (script === undefined) continue;
    const target = await readPosixLauncherTarget(script);
    if (target === undefined || !(await ownsResolved(target))) continue;
    if ((await NodeFSP.realpath(target).catch(() => undefined)) === executable) return script;
  }
  return undefined;
}

export function runtimeSupportsScriptLauncher(executable: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child: NodeChildProcess.ChildProcess;
    try {
      child = guardChild(
        NodeChildProcess.execFile(
          executable,
          ["__ssh-helper", "launcher-capabilities"],
          {
            timeout: CAPABILITY_TIMEOUT_MS,
            maxBuffer: CAPABILITY_MAX_BYTES,
            killSignal: "SIGKILL",
            windowsHide: true,
          },
          (error, stdout, stderr) =>
            finish(error === null && stdout === "script-launcher\n" && stderr === ""),
        ),
        () => finish(false),
      );
    } catch {
      finish(false);
      return;
    }
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish(false);
    }, CAPABILITY_TIMEOUT_MS);
  });
}

export async function writePosixLauncher(
  launcher: string,
  executable: string,
  probe = runtimeSupportsScriptLauncher,
): Promise<void> {
  if (!(await NodeFSP.stat(executable)).isFile()) throw new Error("Target runtime is not a file.");
  const before = await NodeFSP.lstat(launcher);
  const beforeTarget = await posixLauncherTarget(launcher);
  if (beforeTarget === undefined) throw new Error("Launcher is not an owned GOAT launcher.");
  const next = `${launcher}.${process.pid}.${NodeCrypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    if (await probe(executable)) {
      await NodeFSP.writeFile(next, posixLauncherScript(executable), { mode: 0o755, flag: "wx" });
    } else {
      await NodeFSP.symlink(executable, next);
    }
    const after = await NodeFSP.lstat(launcher);
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      (await posixLauncherTarget(launcher)) !== beforeTarget
    ) {
      throw new Error("Launcher changed during the update.");
    }
    await NodeFSP.rename(next, launcher);
  } finally {
    await NodeFSP.rm(next, { force: true });
  }
}

export async function repointRegisteredPosixLaunchers(
  baseDir: string,
  executable: string,
): Promise<void> {
  const versionsDir = NodePath.join(baseDir, "runtime", "goat", "versions");
  const records = await readBounded(
    NodePath.join(baseDir, "runtime", "launchers"),
    LAUNCHER_RECORDS_MAX_BYTES,
  ).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
    throw error;
  });
  if (records === undefined) throw new Error("Launcher registry exceeds its size limit.");
  const realVersions = await NodeFSP.realpath(versionsDir).catch(() => versionsDir);
  const launchers = [...new Set(records.split(/\r?\n/u).filter(Boolean))];
  if (launchers.length > LAUNCHER_CANDIDATE_LIMIT)
    throw new Error("Launcher registry has too many entries.");
  for (const launcher of launchers) {
    if (!NodePath.isAbsolute(launcher)) continue;
    const target = await posixLauncherTarget(launcher);
    if (target === undefined) continue;
    const realTarget = await NodeFSP.realpath(target).catch(() => undefined);
    if (realTarget === undefined || !insideVersions(realVersions, realTarget)) continue;
    await writePosixLauncher(launcher, executable);
  }
}
