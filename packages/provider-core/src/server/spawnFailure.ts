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
  statExecutable = (path: string) => NodeFS.statSync(path).isFile(),
  processCwd = () => process.cwd(),
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
  if (cwd === undefined) {
    if (code === "ENOENT" || code === "EACCES" || code === "EPERM" || code === "ENOTDIR") {
      try {
        processCwd();
      } catch {
        return "cwd_inaccessible";
      }
    }
    if (code !== "ENOENT") return "unknown";
    if (!command) return "missing";
    return executableExists(command.binary, cwd, command.env ?? process.env, statExecutable) ===
      false
      ? "missing"
      : "unknown";
  }
  if (code !== "ENOENT" && code !== "EACCES" && code !== "EPERM" && code !== "ENOTDIR")
    return "unknown";
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
    if (command) {
      const exists = executableExists(
        command.binary,
        cwd,
        command.env ?? process.env,
        statExecutable,
      );
      if (exists === undefined) return "unknown";
      if (exists) return "exec_failed";
    }
    return "missing";
  }
  if (code === "EACCES" || code === "EPERM") return "permission_denied";
  return "unknown";
}

function executableExists(
  binary: string,
  cwd: string | undefined,
  env: NodeJS.ProcessEnv,
  statExecutable: (path: string) => boolean,
): boolean | undefined {
  const paths =
    binary.includes("/") || binary.includes("\\")
      ? [binary]
      : (env.PATH ?? "/usr/bin:/bin")
          .split(NodePath.delimiter)
          .map((dir) => NodePath.join(dir || ".", binary));
  const extensions =
    env.PATHEXT && !NodePath.extname(binary) ? ["", ...env.PATHEXT.split(";")] : [""];
  let uncertain = false;
  const found = paths.some((path) =>
    extensions.some((extension) => {
      try {
        if (cwd === undefined && !NodePath.isAbsolute(path)) return false;
        return statExecutable((cwd === undefined ? path : NodePath.resolve(cwd, path)) + extension);
      } catch (error) {
        if (
          !error ||
          typeof error !== "object" ||
          !("code" in error) ||
          (error.code !== "ENOENT" && error.code !== "ENOTDIR")
        )
          uncertain = true;
        return false;
      }
    }),
  );
  if (found) return true;
  return uncertain || (cwd === undefined && paths.some((path) => !NodePath.isAbsolute(path)))
    ? undefined
    : false;
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
