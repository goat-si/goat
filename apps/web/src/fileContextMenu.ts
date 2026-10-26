/**
 * Right-click actions for a workspace file: reveal it in the environment's
 * file manager, open it in an editor, or copy its path. Reuse the chat file-chip menu's
 * machinery: reveal rides `shell.openInEditor` with `reveal: true`, which the
 * server only honors when its `shellRevealInFileManager` config flag is set,
 * so shell actions work for every client and connection mode.
 */
import { EDITORS, type ContextMenuItem, type EditorId, type EnvironmentId } from "@goat/contracts";

import { resolveDiffPathForWorkspace } from "./diffFileActions";
import {
  revealInFileExplorerLabelForKind,
  revealInFileExplorerLabelForOs,
} from "~/components/preview/fileExplorerLabel";
import { readLocalApi } from "./localApi";
import { serverEnvironment } from "./state/server";
import { shellEnvironment } from "./state/shell";
import { useAtomCommand } from "./state/use-atom-command";
import { resolvePathLinkTarget } from "@goat/shared/fileLinks";
import { toastManager } from "./components/ui/toast";
import { useAtomValue } from "@effect/atom-react";
import { copyFilePath, resolveFilePathCopyTargets } from "./filePathCopy";

export type FileContextMenuAction =
  | "copy-relative"
  | "copy-full"
  | "reveal-in-folder"
  | "open"
  /** Submenu parent; never the activated id. */
  | "open-with"
  | `editor:${EditorId}`;

export interface FileContextMenuTarget {
  readonly environmentId: EnvironmentId | null;
  /** Repo- or workspace-relative file path, as shown in diffs. */
  readonly filePath: string;
  readonly workspaceRoot: string | undefined;
  readonly repositoryRoot?: string | undefined;
}

/** Absolute path on the environment host, or null when it cannot be resolved. */
/**
 * Absolute path on the environment host for a diff-style target, resolving
 * repo-relative paths through the workspace root like every other diff
 * surface. Returns null when the path cannot be resolved, which callers must
 * treat as "no host shell actions available".
 */
export function resolveFileContextMenuAbsolutePath(target: FileContextMenuTarget): string | null {
  const workspaceFilePath = resolveDiffPathForWorkspace({
    filePath: target.filePath,
    workspaceRoot: target.workspaceRoot,
    repositoryRoot: target.repositoryRoot,
  });
  if (workspaceFilePath === null) return null;
  if (target.workspaceRoot === undefined) {
    return workspaceFilePath.startsWith("/") || /^[a-zA-Z]:/.test(workspaceFilePath)
      ? workspaceFilePath
      : null;
  }
  return resolvePathLinkTarget(workspaceFilePath, target.workspaceRoot);
}

const EDITOR_LABEL_BY_ID = new Map(EDITORS.map((editor) => [editor.id, editor.label]));

export interface FileContextMenuCapabilities {
  readonly revealLabel: string | undefined;
  readonly canOpenDefault: boolean;
  readonly editorIds: ReadonlyArray<EditorId>;
}

/**
 * Menu items for a resolved file, offering only what the environment's config
 * advertises: default-app open, reveal (with server-provided wording), and an
 * "Open with" submenu of detected editors. Copying does not require shell capabilities.
 */
export function buildFileContextMenuItems(input: {
  readonly hasAbsolutePath: boolean;
  readonly hasRelativePath: boolean;
  readonly hasFullPath: boolean;
  readonly capabilities: FileContextMenuCapabilities;
}): readonly ContextMenuItem<FileContextMenuAction>[] {
  const items: ContextMenuItem<FileContextMenuAction>[] = [];
  if (input.hasAbsolutePath && input.capabilities.canOpenDefault) {
    items.push({ id: "open", label: "Open", icon: "pencil" });
  }
  if (input.hasAbsolutePath && input.capabilities.revealLabel !== undefined) {
    items.push({
      id: "reveal-in-folder",
      label: input.capabilities.revealLabel,
      icon: "folder-tree",
    });
  }
  const editorIds = input.capabilities.editorIds.filter((id) => id !== "file-manager");
  if (input.hasAbsolutePath && editorIds.length > 0) {
    items.push({
      id: "open-with",
      label: "Open with",
      children: editorIds.map((editorId) => ({
        id: `editor:${editorId}` as FileContextMenuAction,
        label: EDITOR_LABEL_BY_ID.get(editorId) ?? editorId,
      })),
    });
  }
  if (input.hasRelativePath) items.push({ id: "copy-relative", label: "Copy relative path" });
  if (input.hasFullPath) items.push({ id: "copy-full", label: "Copy full path" });
  return items;
}

/**
 * Context-menu actions for files. The environment id is fixed per component
 * (a thread's environment, a file browser's environment), so capabilities
 * resolve once per hook call.
 */
/** Builds and dispatches the file context menu for one environment's files. */
export function useFileContextMenu(environmentId: EnvironmentId | null) {
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, { reportFailure: false });
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));

  const availableEditors = serverConfig?.availableEditors ?? [];
  const capabilities: FileContextMenuCapabilities = {
    // WSL can reveal in Windows Explorer despite reporting Linux; use server wording.
    revealLabel:
      environmentId !== null &&
      serverConfig?.shellRevealInFileManager === true &&
      serverConfig.availableEditors.includes("file-manager")
        ? serverConfig.shellRevealInFileManagerKind === undefined
          ? revealInFileExplorerLabelForOs(serverConfig.environment.platform.os)
          : revealInFileExplorerLabelForKind(serverConfig.shellRevealInFileManagerKind)
        : undefined,
    canOpenDefault: availableEditors.includes("file-manager"),
    editorIds: availableEditors,
  };

  const activate = async (
    action: FileContextMenuAction,
    target: FileContextMenuTarget,
  ): Promise<void> => {
    const copyPaths = resolveFilePathCopyTargets(target);
    if (action === "copy-relative" || action === "copy-full") {
      const path = action === "copy-relative" ? copyPaths.relativePath : copyPaths.fullPath;
      if (path !== null) {
        await copyFilePath(path, action === "copy-relative" ? "Relative path" : "Full path");
      }
      return;
    }
    const absolutePath = resolveFileContextMenuAbsolutePath(target);
    if (absolutePath === null || environmentId === null) return;

    const reveal = action === "reveal-in-folder";
    if (action === "open" && !capabilities.canOpenDefault) return;
    if (reveal && capabilities.revealLabel === undefined) return;
    const editor =
      action === "open" || reveal
        ? ("file-manager" as const)
        : (action.slice("editor:".length) as EditorId);
    if (action !== "open" && !reveal && !capabilities.editorIds.includes(editor)) return;

    const result = await openInEditor({
      environmentId,
      input: { cwd: absolutePath, editor, ...(reveal ? { reveal: true } : {}) },
    });
    if (result._tag !== "Failure") return;
    toastManager.add({
      type: "error",
      title:
        action === "open"
          ? "Could not open file"
          : reveal
            ? "Unable to reveal file"
            : `Could not open in ${EDITOR_LABEL_BY_ID.get(editor) ?? editor}`,
      description: absolutePath,
    });
  };

  const buildItems = (target: FileContextMenuTarget) => {
    const copyPaths = resolveFilePathCopyTargets(target);
    return buildFileContextMenuItems({
      hasAbsolutePath: resolveFileContextMenuAbsolutePath(target) !== null,
      hasRelativePath: copyPaths.relativePath !== null,
      hasFullPath: copyPaths.fullPath !== null,
      capabilities,
    });
  };

  const show = async (
    target: FileContextMenuTarget,
    position?: { x: number; y: number },
  ): Promise<void> => {
    const api = readLocalApi();
    const items = buildItems(target);
    if (items.length === 0 || api === undefined) return;
    const clicked = await api.contextMenu.show(items, position);
    if (clicked === null) return;
    await activate(clicked as FileContextMenuAction, target);
  };

  return {
    buildItems,
    capabilities,
    activate,
    show,
  };
}

/** Convenience callback for onContextMenu handlers. */
/** Returns an onContextMenu callback that shows the menu at the pointer. */
export function useFileContextMenuHandler(environmentId: EnvironmentId | null) {
  const contextMenu = useFileContextMenu(environmentId);
  return (target: FileContextMenuTarget, event?: { clientX: number; clientY: number }) => {
    void contextMenu.show(target, event ? { x: event.clientX, y: event.clientY } : undefined);
  };
}
