import * as NodeFS from "node:fs";
import { isCommandMissingCause, ProviderCommandNotFoundError } from "./snapshotProbe.ts";

export type SpawnFailure = "missing" | "cwd_inaccessible" | "permission_denied" | "unknown";

export function classifySpawnFailure(cause: unknown, cwd: string): SpawnFailure {
  const seen = new Set<unknown>();
  const pending: unknown[] = [cause];
  let code: string | undefined;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    if (current instanceof ProviderCommandNotFoundError) return "missing";
    if ("code" in current && typeof current.code === "string") code ??= current.code;
    if (isCommandMissingCause(current)) code ??= "ENOENT";
    if ("_tag" in current && current._tag === "PermissionDenied") code ??= "EACCES";
    if ("cause" in current) pending.push(current.cause);
    if ("reason" in current) pending.push(current.reason);
    if ("error" in current) pending.push(current.error);
  }
  if (code !== "ENOENT" && code !== "EACCES" && code !== "EPERM" && code !== "ENOTDIR")
    return "unknown";
  try {
    if (!NodeFS.statSync(cwd).isDirectory()) return "cwd_inaccessible";
    NodeFS.accessSync(cwd, NodeFS.constants.X_OK);
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
  if (code === "ENOENT") return "missing";
  if (code === "EACCES" || code === "EPERM") return "permission_denied";
  return "unknown";
}

export function spawnFailureMessage(
  failure: SpawnFailure,
  cwd: string,
  binary: string,
): string | undefined {
  if (failure === "cwd_inaccessible")
    return `The GOAT server process cannot enter the working directory \`${cwd}\`.`;
  if (failure === "permission_denied")
    return `The GOAT server process does not have permission to execute \`${binary}\`.`;
  return undefined;
}
