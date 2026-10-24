import type { FileTree } from "@pierre/trees";

import type { FileTreeCommand } from "./fileViewCommands";

/** Dispatched on a Files panel element to move keyboard focus onto its tree. */
export const FILE_TREE_FOCUS_REQUEST = "goat:file-tree-focus";

export interface FileTreeShortcutContext {
  readonly model: FileTree;
  /** The tree's shadow host; its height sets the page size. */
  readonly host: HTMLElement | null;
  readonly directoryPaths: readonly string[];
  /** Folders expand-all may open; ignored folders such as node_modules are left out. */
  readonly expandableDirectoryPaths: readonly string[];
  readonly canExpandAll: boolean;
  readonly setAllExpanded: (expanded: boolean) => void;
  readonly focusViewer: () => void;
}

/**
 * Pierre keeps a model focus that moves without the DOM: a row the virtualizer has not
 * mounted yet, or a tree that lost DOM focus, would leave the next key press elsewhere.
 * Focus the mounted row button, waiting one frame for the virtualizer when needed.
 */
export function focusTreeRow(host: HTMLElement | null, model: FileTree, path: string): void {
  model.focusPath(path);
  model.scrollToPath(path, { offset: "nearest" });
  const focusMounted = () => {
    const row = host?.shadowRoot?.querySelector<HTMLElement>(
      `[data-item-path="${CSS.escape(path)}"]`,
    );
    row?.focus();
    return row != null;
  };
  if (!focusMounted()) requestAnimationFrame(focusMounted);
}

export function pageSizeFor(host: HTMLElement | null, model: FileTree): number {
  const itemHeight = model.getItemHeight();
  if (host === null || itemHeight <= 0) return 1;
  return Math.max(1, Math.floor(host.clientHeight / itemHeight) - 1);
}

export function pagedPath(model: FileTree, direction: 1 | -1, pageSize: number): string | null {
  const count = model.getVisibleCount();
  if (count === 0) return null;
  const from = Math.max(0, model.getFocusedIndex());
  const index = Math.min(count - 1, Math.max(0, from + direction * pageSize));
  return model.getVisibleRows(index, index)[0]?.path ?? null;
}

/** A folder and every known folder below it, as tree paths with a trailing slash. */
export function descendantDirectories(
  folderPath: string,
  directoryPaths: readonly string[],
): string[] {
  return directoryPaths.filter((path) => path.startsWith(folderPath));
}

function parentDirectory(path: string): string | null {
  const trimmed = path.replace(/\/$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash < 0 ? null : `${trimmed.slice(0, slash)}/`;
}

function setExpanded(model: FileTree, paths: readonly string[], expanded: boolean) {
  for (const path of paths) {
    const item = model.getItem(path);
    if (item?.isDirectory()) {
      if (expanded) item.expand();
      else item.collapse();
    }
  }
}

/**
 * Toggles a folder with everything below it, as Option-click does in Finder and
 * VS Code. Only folders the tree has already listed are reached; each one listed
 * after expanding is picked up by the next press.
 */
export function toggleDirectoryRecursively(
  context: FileTreeShortcutContext,
  folderPath: string,
  expand: boolean,
): void {
  const below = descendantDirectories(folderPath, context.directoryPaths);
  if (expand) {
    const expandable = new Set(context.expandableDirectoryPaths);
    setExpanded(context.model, [folderPath, ...below.filter((path) => expandable.has(path))], true);
  } else {
    setExpanded(context.model, [...below].reverse(), false);
  }
}

/** One printable character with no command modifier starts a tree search. */
export function typeToFindSeed(event: KeyboardEvent): string | null {
  if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return null;
  return /^\S$/u.test(event.key) ? event.key : null;
}

/** Runs a tree command against the focused row. Returns whether it applied. */
export function runFileTreeCommand(
  command: FileTreeCommand,
  context: FileTreeShortcutContext,
): boolean {
  const { model, host } = context;
  const focused = model.getFocusedItem();
  switch (command) {
    case "files.pageDown":
    case "files.pageUp": {
      const path = pagedPath(
        model,
        command === "files.pageDown" ? 1 : -1,
        pageSizeFor(host, model),
      );
      if (path === null) return false;
      focusTreeRow(host, model, path);
      return true;
    }
    case "files.open": {
      if (focused === null) return false;
      if (focused.isDirectory()) {
        focused.expand();
        focusTreeRow(host, model, focused.getPath());
        return true;
      }
      for (const path of model.getSelectedPaths()) model.getItem(path)?.deselect();
      focused.select();
      context.focusViewer();
      return true;
    }
    case "files.expandRecursive":
    case "files.collapseRecursive": {
      if (focused === null) return false;
      const expand = command === "files.expandRecursive";
      const folder = focused.isDirectory() ? focused.getPath() : parentDirectory(focused.getPath());
      if (folder === null || (expand && !focused.isDirectory())) return false;
      toggleDirectoryRecursively(context, folder, expand);
      focusTreeRow(host, model, folder);
      return true;
    }
    case "files.expandAll":
      if (!context.canExpandAll) return false;
      context.setAllExpanded(true);
      return true;
    case "files.collapseAll":
      context.setAllExpanded(false);
      return true;
  }
}
