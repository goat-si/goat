// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

export function launchEnvironment(environment: NodeJS.ProcessEnv = {}, cwd?: string | null) {
  const resolved = { ...environment };
  for (const key of Object.keys(resolved)) {
    if (NodePath.delimiter === ";" ? key.toUpperCase() !== "PATH" : key !== "PATH") continue;
    const value = resolved[key];
    if (value === undefined) continue;
    resolved[key] = value
      .split(NodePath.delimiter)
      .map((entry) => {
        // On POSIX an empty entry (leading, trailing or doubled separator) is the current directory.
        if (entry === "" && NodePath.delimiter === ":")
          return NodePath.resolve(cwd ?? process.cwd());
        const unquoted = entry.trim().replace(/^"|"$/gu, "");
        return unquoted.length === 0 || NodePath.isAbsolute(unquoted)
          ? entry
          : NodePath.resolve(cwd ?? process.cwd(), unquoted);
      })
      .join(NodePath.delimiter);
  }
  return resolved;
}
