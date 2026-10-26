// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";

/**
 * How `resolveWindowsGitBash` reads the machine. Tests pass fakes; production uses
 * the registry and the filesystem.
 */
export interface WindowsGitBashDeps {
  /** Raw `reg query "HKLM\\SOFTWARE\\OpenSSH" /v DefaultShell` output. */
  readonly readOpenSshDefaultShell: () => Effect.Effect<string | undefined>;
  readonly exists: (path: string) => Effect.Effect<boolean>;
  readonly env: NodeJS.ProcessEnv;
}

const REG_SZ_VALUE = /^\s*DefaultShell\s+REG_SZ\s+(.+?)\s*$/iu;

/** The REG_SZ data from `reg query`, or undefined when the value is absent. */
const parseOpenSshDefaultShell = (output: string | undefined): string | undefined => {
  if (output === undefined) return undefined;
  for (const line of output.split(/\r?\n/u)) {
    const value = REG_SZ_VALUE.exec(line)?.[1];
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
};

const windowsPath = (value: string) =>
  value.replaceAll("/", "\\").replace(/\\+$/u, "").toLowerCase();

/**
 * WSL's bash lives in `%SystemRoot%\\System32`. A path lookup for bare `bash` finds
 * that launcher, which cannot see a GOAT worktree.
 */
const isUnderSystem32 = (candidate: string, env: NodeJS.ProcessEnv): boolean => {
  const normalized = windowsPath(candidate);
  const systemRoot = (env.SystemRoot ?? env.SYSTEMROOT ?? "").trim();
  if (systemRoot !== "") {
    const prefix = `${windowsPath(systemRoot)}\\system32`;
    if (normalized === prefix || normalized.startsWith(`${prefix}\\`)) return true;
  }
  return /(?:^|\\)system32(?:\\|$)/u.test(normalized);
};

/** Git for Windows `bash.exe` with a real directory, never a PATH name. */
const isGitBashExecutable = (candidate: string, env: NodeJS.ProcessEnv): boolean => {
  const trimmed = candidate.trim();
  if (trimmed === "" || /^bash(?:\.exe)?$/iu.test(trimmed)) return false;
  if (NodePath.win32.basename(trimmed).toLowerCase() !== "bash.exe") return false;
  return !isUnderSystem32(trimmed, env);
};

const envDir = (env: NodeJS.ProcessEnv, key: string): string | undefined => {
  const value = env[key]?.trim();
  return value === undefined || value === "" ? undefined : value;
};

const gitBashUnder = (
  root: string | undefined,
  ...rest: ReadonlyArray<string>
): string | undefined =>
  root === undefined ? undefined : NodePath.win32.join(root, ...rest, "Git", "bin", "bash.exe");

const fallbackCandidates = (env: NodeJS.ProcessEnv): ReadonlyArray<string> =>
  [
    gitBashUnder(envDir(env, "ProgramFiles")),
    gitBashUnder(envDir(env, "ProgramW6432")),
    gitBashUnder(envDir(env, "ProgramFiles(x86)")),
    gitBashUnder(envDir(env, "LOCALAPPDATA"), "Programs"),
  ].filter((candidate): candidate is string => candidate !== undefined);

/**
 * Git for Windows bash on this machine: the OpenSSH DefaultShell when it is
 * `bash.exe`, otherwise the standard install locations. Undefined when none exist.
 */
export const resolveWindowsGitBash = Effect.fn("server.ssh_runtime_git_bash.resolve")(function* (
  deps: WindowsGitBashDeps,
) {
  const configured = parseOpenSshDefaultShell(yield* deps.readOpenSshDefaultShell());
  if (
    configured !== undefined &&
    isGitBashExecutable(configured, deps.env) &&
    (yield* deps.exists(configured))
  )
    return configured;
  for (const candidate of fallbackCandidates(deps.env)) {
    if (isGitBashExecutable(candidate, deps.env) && (yield* deps.exists(candidate)))
      return candidate;
  }
  return undefined;
});

/**
 * Git Bash treats `\` as an escape. A script path it receives uses forward slashes;
 * `/bin/sh` and other commands keep the path they were given.
 */
export const bashScriptArg = (shell: string, scriptFile: string): string =>
  NodePath.win32.basename(shell).toLowerCase() === "bash.exe"
    ? scriptFile.replaceAll("\\", "/")
    : scriptFile;

const readOpenSshDefaultShell = (): Effect.Effect<string | undefined> =>
  Effect.promise(
    () =>
      new Promise((resolve) => {
        const child = NodeChildProcess.spawn(
          "reg",
          ["query", String.raw`HKLM\SOFTWARE\OpenSSH`, "/v", "DefaultShell"],
          { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
        );
        const stdout: Buffer[] = [];
        let settled = false;
        const finish = (value: string | undefined) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
        child.once("error", () => finish(undefined));
        child.once("close", (code) =>
          finish(code === 0 ? Buffer.concat(stdout).toString("utf8") : undefined),
        );
      }),
  );

const fileExists = (path: string): Effect.Effect<boolean> =>
  Effect.promise(() =>
    NodeFS.promises.access(path).then(
      () => true,
      () => false,
    ),
  );

export const defaultWindowsGitBash = (): Effect.Effect<string | undefined> =>
  resolveWindowsGitBash({
    readOpenSshDefaultShell,
    exists: fileExists,
    env: process.env,
  });
