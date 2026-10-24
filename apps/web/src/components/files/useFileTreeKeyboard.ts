import type { ResolvedKeybindingsConfig } from "@goat/contracts";
import type { FileTree } from "@pierre/trees";
import { useEffect, useRef, type RefObject } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";

import { sourceEditorContent } from "./sourceEditorContent";
import { fileTreeCopyPaths, type FilePathCopyCommand } from "./filePathCopyShortcut";
import {
  FILE_TREE_FOCUS_REQUEST,
  focusTreeRow,
  isDirectoryHandle,
  runFileTreeCommand,
  toggleDirectoryRecursively,
  typeToFindSeed,
  type FileTreeShortcutContext,
} from "./fileTreeShortcuts";
import {
  FILE_ITEM_COMMANDS,
  FILE_TREE_COMMANDS,
  fileViewCommandForEvent,
} from "./fileViewCommands";
import type { useFileTreeActions } from "./useFileTreeActions";

/** The Files panel's keyboard: tree commands, item actions, type-to-find and Alt-click. */
export function useFileTreeKeyboard(input: {
  readonly panelRef: RefObject<HTMLDivElement | null>;
  readonly model: FileTree;
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly directoryPaths: readonly string[];
  readonly expandableDirectoryPaths: readonly string[];
  readonly canExpandAll: boolean;
  readonly setAllExpanded: (expanded: boolean) => void;
  readonly onSearchValueChange: (value: string) => void;
  readonly onRefresh: () => void;
  readonly copyTreePaths: (command: FilePathCopyCommand, rows: readonly string[]) => Promise<void>;
  readonly treeActions: ReturnType<typeof useFileTreeActions>;
}) {
  const {
    panelRef,
    model,
    keybindings,
    directoryPaths,
    expandableDirectoryPaths,
    setAllExpanded,
    copyTreePaths,
    treeActions,
  } = input;
  const handleSearchValueChange = input.onSearchValueChange;
  const handleRefresh = input.onRefresh;
  const hostFolder = !input.canExpandAll;
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const treeHost = () =>
    panelRef.current?.querySelector<HTMLElement>("file-tree-container") ?? null;
  const focusSearch = (seed?: string) => {
    if (seed !== undefined) handleSearchValueChange(seed);
    searchInputRef.current?.focus();
  };
  const focusTree = () => {
    const path =
      model.getFocusedPath() ??
      model.getSelectedPaths().at(-1) ??
      model.getVisibleRows(0, 0)[0]?.path;
    if (path !== undefined) focusTreeRow(treeHost(), model, path);
  };
  // The source editor's text when the view has one, else the surface root (tabIndex -1).
  const focusViewer = () => {
    const view = panelRef.current?.closest<HTMLElement>("[data-file-view]");
    if (view) (sourceEditorContent(view) ?? view).focus();
  };
  const shortcutContext = (): FileTreeShortcutContext => ({
    model,
    host: treeHost(),
    directoryPaths,
    expandableDirectoryPaths,
    canExpandAll: !hostFolder,
    setAllExpanded,
    focusViewer,
  });
  // Capture runs before the rows' own handlers in the tree's shadow root, which
  // treat Alt and Cmd/Ctrl arrows as plain arrows and stop them.
  const handleShortcut = useStableCallback((event: KeyboardEvent) => {
    const command = fileViewCommandForEvent(event, keybindings, [
      ...FILE_TREE_COMMANDS,
      ...FILE_ITEM_COMMANDS,
      "files.find",
    ]);
    if (command === null) {
      const seed = event.target === treeHost() ? typeToFindSeed(event) : null;
      if (seed === null) return;
      event.preventDefault();
      focusSearch(seed);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (command === "files.pageDown" || command === "files.pageUp") {
      runFileTreeCommand(command, shortcutContext());
    } else if (event.repeat) {
      return;
    } else if (command === "files.find") {
      focusSearch();
    } else if (command === "files.copyPath" || command === "files.copyRelativePath") {
      void copyTreePaths(command, fileTreeCopyPaths(model));
    } else if (command === "files.copyName") {
      void treeActions.copyNames(fileTreeCopyPaths(model));
    } else if (command === "files.copyContents") {
      void treeActions.copyContents(fileTreeCopyPaths(model));
    } else if (command === "files.revealInFileManager") {
      void treeActions.reveal(fileTreeCopyPaths(model));
    } else if (command === "files.refresh") {
      handleRefresh();
    } else if (command === "files.toggleFocus") {
      focusViewer();
    } else {
      runFileTreeCommand(command, shortcutContext());
    }
  });
  // Option-click opens or closes a folder with everything below it, as in Finder and VS Code.
  const handleRecursiveClick = useStableCallback((event: MouseEvent) => {
    if (!event.altKey || event.button !== 0) return;
    const row = event
      .composedPath()
      .find(
        (node): node is HTMLElement =>
          node instanceof HTMLElement && node.dataset.itemPath?.endsWith("/") === true,
      );
    const path = row?.dataset.itemPath;
    const item = path === undefined ? null : model.getItem(path);
    if (path === undefined || !isDirectoryHandle(item)) return;
    event.preventDefault();
    event.stopPropagation();
    toggleDirectoryRecursively(shortcutContext(), path, !item.isExpanded());
    focusTreeRow(treeHost(), model, path);
  });
  const handleFocusRequest = useStableCallback(() => focusTree());
  useEffect(() => {
    const panel = panelRef.current;
    if (panel === null) return;
    panel.addEventListener("keydown", handleShortcut, true);
    panel.addEventListener("click", handleRecursiveClick, true);
    panel.addEventListener(FILE_TREE_FOCUS_REQUEST, handleFocusRequest);
    return () => {
      panel.removeEventListener("keydown", handleShortcut, true);
      panel.removeEventListener("click", handleRecursiveClick, true);
      panel.removeEventListener(FILE_TREE_FOCUS_REQUEST, handleFocusRequest);
    };
  }, [handleFocusRequest, handleRecursiveClick, handleShortcut, panelRef]);
  return { searchInputRef, focusTree };
}
