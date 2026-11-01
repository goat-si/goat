// @effect-diagnostics nodeBuiltinImport:off -- Canonical containment must inspect symlinks on the destination.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

export function validAgentRelativePath(value: string, allowRoot = false) {
  if (
    (value === "" && !allowRoot) ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("~") ||
    NodePath.isAbsolute(value) ||
    /^[a-z]:/i.test(value)
  )
    return false;
  return value.split("/").every((segment) => {
    const name = (segment.split(":")[0] ?? "").replace(/[. ]+$/, "").toUpperCase();
    return segment !== ".." && name !== ".GIT" && name !== "GIT~1";
  });
}

export async function agentWorkspacePath(root: string, relativePath: string, allowMissing = false) {
  if (!validAgentRelativePath(relativePath, true)) throw new TypeError("Invalid workspace path.");
  const realRoot = await NodeFSP.realpath(root);
  const named = NodePath.resolve(root, relativePath);
  let candidate = named;
  let suffix = "";
  for (;;) {
    try {
      const real = NodePath.join(await NodeFSP.realpath(candidate), suffix);
      const relative = NodePath.relative(realRoot, real);
      if (
        relative === ".." ||
        relative.startsWith(`..${NodePath.sep}`) ||
        NodePath.isAbsolute(relative) ||
        !validAgentRelativePath(relative.split(NodePath.sep).join("/"), true)
      )
        throw new TypeError("Path escapes the workspace or enters Git metadata.");
      return { root: realRoot, path: real };
    } catch (cause) {
      if (
        !allowMissing ||
        !(cause instanceof Error) ||
        !("code" in cause) ||
        cause.code !== "ENOENT"
      )
        throw cause;
      const link = await NodeFSP.lstat(candidate).catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
      });
      if (link !== null || NodePath.dirname(candidate) === candidate) throw cause;
      suffix = NodePath.join(NodePath.basename(candidate), suffix);
      candidate = NodePath.dirname(candidate);
    }
  }
}
