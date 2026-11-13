// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as HostProcess from "@goat/shared/HostProcess";
import { SpawnExecutableResolution } from "@goat/shared/shell";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/** Node 20.12+ cannot spawn Windows launcher scripts without a shell; the SDK cannot use these as executables. */
const WINDOWS_SHIM_EXTENSIONS: ReadonlySet<string> = new Set([".cmd", ".bat", ".ps1"]);

export const isWindowsClaudeLauncherShimPath = (filePath: string): boolean =>
  WINDOWS_SHIM_EXTENSIONS.has(NodePath.win32.extname(filePath).toLowerCase());

/** New packages provide bin/claude.exe; older packages need a JavaScript runtime for cli.js. */
const NPM_PACKAGE_ENTRY_CANDIDATES = [
  ["node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"],
  ["node_modules", "@anthropic-ai", "claude-code", "cli.js"],
] as const;

export type ExecutableFileCheck = (filePath: string) => boolean;

function isExistingFile(filePath: string): boolean {
  try {
    return NodeFS.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export const ClaudeExecutableFileCheck = Context.Reference<ExecutableFileCheck>(
  "server/provider/Drivers/ClaudeExecutableFileCheck",
  {
    defaultValue: () => isExistingFile,
  },
);

export interface ClaudeSdkExecutable {
  readonly path: string;
  /** False on Windows when no file was found for the binary; other platforms leave lookup to spawn. */
  readonly found: boolean;
}

/** On Windows the SDK skips shell and PATH/PATHEXT lookup: bare names and .cmd shims fail. */
export const resolveClaudeSdkExecutable = Effect.fn("resolveClaudeSdkExecutable")(function* (
  binaryPath: string,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<ClaudeSdkExecutable> {
  const platform = yield* HostProcess.Platform;
  if (platform !== "win32") {
    return { path: binaryPath, found: true };
  }

  const resolveExecutable = yield* SpawnExecutableResolution;
  const isFile = yield* ClaudeExecutableFileCheck;
  const resolved = resolveExecutable(binaryPath, platform, environment);
  if (resolved === undefined) {
    return { path: binaryPath, found: false };
  }
  const extension = NodePath.win32.extname(resolved).toLowerCase();
  if (!WINDOWS_SHIM_EXTENSIONS.has(extension)) {
    return { path: resolved, found: true };
  }

  const shimDirectory = NodePath.win32.dirname(resolved);
  for (const entrySegments of NPM_PACKAGE_ENTRY_CANDIDATES) {
    const candidate = NodePath.win32.join(shimDirectory, ...entrySegments);
    if (isFile(candidate)) {
      return { path: candidate, found: true };
    }
  }

  yield* Effect.logWarning(
    "Claude launcher shim resolved but no known package entry was found next to it; the Claude Agent SDK cannot spawn launcher scripts directly.",
    { binaryPath, resolvedShimPath: resolved },
  );
  return { path: binaryPath, found: false };
});

export const resolveClaudeSdkExecutablePath = (
  binaryPath: string,
  environment: NodeJS.ProcessEnv,
): Effect.Effect<string> =>
  resolveClaudeSdkExecutable(binaryPath, environment).pipe(Effect.map((resolved) => resolved.path));
