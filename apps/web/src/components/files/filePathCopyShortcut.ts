import type { FileTree } from "@pierre/trees";

import { toastManager } from "~/components/ui/toast";
import { copyFilePath, resolveFilePathCopyTargets } from "~/filePathCopy";

export type FilePathCopyCommand = "files.copyPath" | "files.copyRelativePath";

/**
 * The rows a copy acts on, by VS Code's explorer rule: a multi-selection wins,
 * otherwise the focused row (a folder just toggled with the keyboard keeps
 * focus but not selection), otherwise the selected row.
 */
export function fileTreeCopyPaths(
  model: Pick<FileTree, "getFocusedPath" | "getSelectedPaths">,
): string[] {
  const selected = model.getSelectedPaths();
  const focused = model.getFocusedPath();
  const paths = selected.length > 1 ? selected : focused !== null ? [focused] : selected;
  return paths.map((path) => path.replace(/\/$/, ""));
}

/**
 * Relative paths start at the thread's workspace root, the same root the
 * copy menu's tooltip names. A path outside it has no relative form, and a
 * selection is copied whole or not at all.
 */
export async function copyFilePathsForCommand(
  command: FilePathCopyCommand,
  filePaths: readonly string[],
  workspaceRoot: string,
): Promise<void> {
  if (filePaths.length === 0) return;
  const full = command === "files.copyPath";
  const paths = filePaths.map((filePath) => {
    const targets = resolveFilePathCopyTargets({ filePath, workspaceRoot });
    return full ? targets.fullPath : targets.relativePath;
  });
  const missing = paths.filter((path) => path === null).length;
  if (missing > 0) {
    const subject =
      filePaths.length === 1 ? "This item is" : `${missing} of ${filePaths.length} items are`;
    toastManager.add({
      type: "error",
      title: full ? "No full path to copy" : "No relative path to copy",
      description: full ? filePaths.join("\n") : `${subject} outside ${workspaceRoot}`,
    });
    return;
  }
  await copyFilePath(
    paths.filter((path) => path !== null),
    full ? "Full path" : "Relative path",
  );
}

export function hasRelativeCopyPaths(filePaths: readonly string[], workspaceRoot: string) {
  return filePaths.every(
    (filePath) => resolveFilePathCopyTargets({ filePath, workspaceRoot }).relativePath !== null,
  );
}
