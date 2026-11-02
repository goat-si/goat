// @effect-diagnostics-next-line nodeBuiltinImport:off -- FileSystem.access cannot test directory search permission.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- resolves executable paths synchronously during spawn diagnosis.
import * as NodePath from "node:path";
import { isCommandMissingCause } from "./snapshotProbe.ts";

export type SpawnFailure =
  | "missing"
  | "cwd_inaccessible"
  | "permission_denied"
  | "exec_failed"
  | "unknown";

export function classifySpawnFailure(
  cause: unknown,
  cwd: string | undefined,
  accessDirectory = (path: string) => NodeFS.accessSync(path, NodeFS.constants.X_OK),
  command?: { binary: string; env?: NodeJS.ProcessEnv | undefined },
): SpawnFailure {
  const seen = new Set<unknown>();
  const pending: unknown[] = [cause];
  let code: string | undefined;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    if (
      "_tag" in current &&
      current._tag === "ProviderCommandNotFoundError" &&
      isCommandMissingCause(current)
    )
      return "missing";
    if ("code" in current && typeof current.code === "string") code ??= current.code;
    if (isCommandMissingCause(current)) code ??= "ENOENT";
    if ("_tag" in current && current._tag === "PermissionDenied") code ??= "EACCES";
    if ("cause" in current) pending.push(current.cause);
    if ("reason" in current) pending.push(current.reason);
    if ("error" in current) pending.push(current.error);
  }
  if (code !== "ENOENT" && code !== "EACCES" && code !== "EPERM" && code !== "ENOTDIR")
    return "unknown";
  if (cwd === undefined) return "cwd_inaccessible";
  try {
    if (!NodeFS.statSync(cwd).isDirectory()) return "cwd_inaccessible";
    accessDirectory(cwd);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error.code === "ENOENT" ||
        error.code === "EACCES" ||
        error.code === "EPERM" ||
        error.code === "ENOTDIR")
    )
      return "cwd_inaccessible";
    return "unknown";
  }
  if (code === "ENOENT") {
    if (command && executableExists(command.binary, cwd, command.env ?? process.env))
      return "exec_failed";
    return "missing";
  }
  if (code === "EACCES" || code === "EPERM") return "permission_denied";
  return "unknown";
}

function executableExists(binary: string, cwd: string, env: NodeJS.ProcessEnv): boolean {
  const paths =
    binary.includes("/") || binary.includes("\\")
      ? [NodePath.resolve(cwd, binary)]
      : (env.PATH ?? "/usr/bin:/bin")
          .split(NodePath.delimiter)
          .map((dir) => NodePath.resolve(cwd, dir || ".", binary));
  const extensions =
    env.PATHEXT && !NodePath.extname(binary) ? ["", ...env.PATHEXT.split(";")] : [""];
  return paths.some((path) =>
    extensions.some((extension) => {
      try {
        return NodeFS.statSync(path + extension).isFile();
      } catch {
        return false;
      }
    }),
  );
}

export function spawnFailureMessage(
  failure: SpawnFailure,
  cwd: string | undefined,
  binary: string,
): string | undefined {
  if (failure === "cwd_inaccessible")
    return cwd === undefined
      ? "The GOAT server process cannot access its working directory."
      : `The GOAT server process cannot enter the working directory \`${cwd}\`.`;
  if (failure === "exec_failed")
    return `The executable \`${binary}\` exists but could not be started; its interpreter or loader may be missing.`;
  if (failure === "permission_denied")
    return `The GOAT server process does not have permission to execute \`${binary}\`.`;
  return undefined;
}

export function safeProcessCwd(): string | undefined {
  try {
    return process.cwd();
  } catch {
    return undefined;
  }
}
