import type { KeybindingCommand, ResolvedKeybindingsConfig } from "@goat/contracts";

import { matchesPageCommand, pageCommandShortcutLabel } from "~/keybindings";
import { isEditableFocused, isTextFieldFocused } from "~/lib/editableFocus";
import { isFileTreeFocused } from "~/lib/fileViewFocus";

export type FileViewCommand = Extract<KeybindingCommand, `files.${string}`>;

export const FILE_TREE_COMMANDS = [
  "files.pageDown",
  "files.pageUp",
  "files.open",
  "files.expandRecursive",
  "files.collapseRecursive",
  "files.expandAll",
  "files.collapseAll",
] as const satisfies readonly FileViewCommand[];
export type FileTreeCommand = (typeof FILE_TREE_COMMANDS)[number];

/** Commands that act while a source editor's text has focus. Form fields never trigger any. */
const EDITOR_SAFE_COMMANDS: ReadonlySet<FileViewCommand> = new Set(["files.find"]);

/**
 * The file command a key press asks for, checked in `commands` order.
 *
 * matchesPageCommand ignores built-in defaults stored later in the config: the server
 * backfills new defaults ahead of persisted rules, so on an existing install the
 * persisted chat.find on mod+f would otherwise shadow files.find. A rule the person
 * added or changed still shadows a file command.
 */
export function fileViewCommandForEvent<Command extends FileViewCommand>(
  event: KeyboardEvent,
  keybindings: ResolvedKeybindingsConfig,
  commands: readonly Command[],
): Command | null {
  if (event.defaultPrevented || event.isComposing) return null;
  const textField = isTextFieldFocused(event.target);
  const editable = isEditableFocused(event.target);
  const context = {
    fileViewFocus: true,
    fileTreeFocus: isFileTreeFocused(event.target),
    editableFocus: editable,
  };
  return (
    commands.find(
      (command) =>
        !(EDITOR_SAFE_COMMANDS.has(command) ? textField : editable) &&
        matchesPageCommand(event, keybindings, command, { context }),
    ) ?? null
  );
}

/** The shortcut a file command answers to inside the file view, for tooltips and menus. */
export function fileViewShortcutLabel(
  keybindings: ResolvedKeybindingsConfig,
  command: FileViewCommand,
): string | null {
  return pageCommandShortcutLabel(keybindings, command, {
    context: { fileViewFocus: true, fileTreeFocus: true, editableFocus: false },
  });
}
