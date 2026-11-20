// @effect-diagnostics nodeBuiltinImport:off -- Synchronous executable discovery is shared with shell resolution.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { GIT_FOR_WINDOWS_BUILDS } from "./gitWindowsReads.ts";

// Git 2.56 x64 uses ucrt64; ARM64 uses clangarm64; older x64/32-bit builds use mingw64/mingw32.

function isFileSync(filePath: string): boolean {
  try {
    return NodeFS.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/** Bypass the launcher's extra process and kernel-token leak. Retain it when MSYSTEM is set, or git.exe omits hook/helper PATH entries. */
export function preferGitForWindowsBinary(
  executable: string,
  env: NodeJS.ProcessEnv,
  isFile: (filePath: string) => boolean = isFileSync,
): string {
  if (env.MSYSTEM) return executable;
  const path = NodePath.win32;
  if (path.basename(executable).toLowerCase() !== "git.exe") return executable;
  const launcherDirectory = path.dirname(executable);
  const launcherFolder = path.basename(launcherDirectory).toLowerCase();
  if (launcherFolder !== "cmd" && launcherFolder !== "bin") return executable;
  const installRoot = path.dirname(launcherDirectory);
  for (const build of GIT_FOR_WINDOWS_BUILDS) {
    const candidate = path.join(installRoot, build, "bin", "git.exe");
    if (isFile(candidate)) return candidate;
  }
  return executable;
}

// npm cmd-shim format for native executables.
const NPM_EXECUTABLE_SHIM_PREFIX = [
  "@ECHO off",
  "GOTO start",
  ":find_dp0",
  "SET dp0=%~dp0",
  "EXIT /b",
  ":start",
  "SETLOCAL",
  "CALL :find_dp0",
];
const NPM_EXECUTABLE_SHIM_RUN = /^"%dp0%\\([^"%]+\.exe)" +%\*$/;

function readFileSyncOrUndefined(filePath: string): string | undefined {
  try {
    return NodeFS.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

/** Resolve shims that only launch native executables so direct spawning keeps them in libuv's kill-on-close job. */
export function npmShimExecutable(
  shimPath: string,
  readFile: (filePath: string) => string | undefined = readFileSyncOrUndefined,
  isFile: (filePath: string) => boolean = isFileSync,
): string | undefined {
  const path = NodePath.win32;
  if (path.extname(shimPath).toLowerCase() !== ".cmd") return undefined;
  // Match exactly because preserved SET whitespace can select a different file.
  const lines = readFile(shimPath)
    ?.split(/\r?\n/)
    .filter((line) => line.length > 0);
  if (lines?.length !== NPM_EXECUTABLE_SHIM_PREFIX.length + 1) return undefined;
  if (NPM_EXECUTABLE_SHIM_PREFIX.some((expected, index) => lines[index] !== expected)) {
    return undefined;
  }
  const target = NPM_EXECUTABLE_SHIM_RUN.exec(lines.at(-1) ?? "")?.[1];
  if (target === undefined) return undefined;
  const executable = path.join(path.dirname(shimPath), target);
  return isFile(executable) ? executable : undefined;
}
