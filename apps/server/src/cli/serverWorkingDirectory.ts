// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export function recoverServerWorkingDirectory(): { original?: string; current?: string } {
  let original: string | undefined;
  try {
    original = process.cwd();
    NodeFS.accessSync(original, NodeFS.constants.X_OK);
    return {};
  } catch {
    if (original) {
      try {
        NodeFS.statSync(original);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") original = undefined;
      }
    }
  }
  let home: string | undefined;
  try {
    home = NodeOS.homedir();
  } catch {
    /* Try the filesystem root. */
  }
  for (const candidate of [home, "/"]) {
    if (!candidate) continue;
    try {
      NodeFS.accessSync(candidate, NodeFS.constants.X_OK);
      process.chdir(candidate);
      return { original, current: process.cwd() };
    } catch {
      /* Try the next location. */
    }
  }
  throw new Error("Cannot access the current working directory, home directory, or /.");
}

export function resolveFromOriginalWorkingDirectory(value: string, original?: string): string {
  const trimmed = value.trim();
  if (
    !original ||
    !trimmed ||
    trimmed === "~" ||
    /^~[\\/]/.test(trimmed) ||
    NodePath.isAbsolute(trimmed)
  )
    return value;
  return NodePath.resolve(original, trimmed);
}
