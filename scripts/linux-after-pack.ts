// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

export async function removeSharedWriteAccess(path: string): Promise<void> {
  const stats = await NodeFSP.lstat(path);
  if (stats.isSymbolicLink()) return;
  if (stats.mode & 0o022) await NodeFSP.chmod(path, stats.mode & 0o7755);
  if (!stats.isDirectory()) return;
  for (const entry of await NodeFSP.readdir(path)) {
    await removeSharedWriteAccess(NodePath.join(path, entry));
  }
}
