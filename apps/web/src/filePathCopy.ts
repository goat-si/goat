import {
  isAbsolutePath,
  resolveWorkspaceFilePath,
  workspaceRelativeFilePath,
} from "@goat/shared/path";

import { resolveDiffPathForWorkspace } from "./diffFileActions";
import { writeTextToClipboard } from "./hooks/useCopyToClipboard";
import { toastManager } from "./components/ui/toast";

/** Copy targets use the destination environment's roots, never the browser's origin. */
export function resolveFilePathCopyTargets(input: {
  readonly filePath: string;
  readonly workspaceRoot: string | undefined;
  readonly repositoryRoot?: string | undefined;
}) {
  const path = input.filePath;
  const workspacePath = resolveDiffPathForWorkspace({
    ...input,
    filePath: path,
    repositoryRoot: input.repositoryRoot,
  });
  const root = input.repositoryRoot ?? input.workspaceRoot;
  const fullPath = isAbsolutePath(path)
    ? path
    : root && isAbsolutePath(root)
      ? resolveWorkspaceFilePath(path, root)
      : null;
  return {
    relativePath: fullPath
      ? workspaceRelativeFilePath(fullPath, input.workspaceRoot)
      : workspacePath,
    fullPath,
  };
}

export type FilePathCopyKind = "Relative path" | "Full path";

/**
 * Reports success only after either the Clipboard API or its fallback succeeds.
 * Several paths go on separate lines, as VS Code and Zed copy a multi-selection.
 */
export async function copyFilePath(path: string | readonly string[], kind: FilePathCopyKind) {
  const paths = typeof path === "string" ? [path] : path;
  if (paths.length === 0) return;
  const text = paths.join("\n");
  try {
    if (!(await writeTextToClipboard(text, kind.toLowerCase()))) return;
    toastManager.add({
      type: "success",
      title:
        paths.length === 1 ? `${kind} copied` : `${paths.length} ${kind.toLowerCase()}s copied`,
      description: text,
    });
  } catch (error) {
    toastManager.add({
      type: "error",
      title: `Failed to copy ${kind.toLowerCase()}`,
      description: error instanceof Error ? error.message : "An error occurred.",
    });
  }
}
