import { useAtomValue } from "@effect/atom-react";

import { MorphIcon } from "~/components/MorphIcon";
import { Keyboard } from "~/components/solar/nodes";
import { Button } from "~/components/ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "~/components/ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { isMacPlatform } from "~/lib/utils";
import { primaryServerKeybindingsAtom } from "~/state/server";

import { fileViewShortcutLabel, type FileViewCommand } from "./fileViewCommands";

const COMMAND_ROWS: ReadonlyArray<readonly [FileViewCommand, string]> = [
  ["files.find", "Search files, or find in the open file"],
  ["files.open", "Open the focused file"],
  ["files.pageDown", "Next page"],
  ["files.pageUp", "Previous page"],
  ["files.expandRecursive", "Open a folder and its subfolders"],
  ["files.collapseRecursive", "Close a folder and its subfolders"],
  ["files.expandAll", "Expand all folders"],
  ["files.collapseAll", "Collapse all folders"],
  ["files.goToLine", "Go to line"],
  ["files.toggleFocus", "Switch between the tree and the file"],
  ["files.revealInFileManager", "Reveal in the file manager"],
  ["files.refresh", "Refresh"],
  ["files.copyPath", "Copy full path"],
  ["files.copyRelativePath", "Copy relative path"],
  ["files.copyName", "Copy name"],
  ["files.copyContents", "Copy contents"],
];

function builtInRows(): ReadonlyArray<readonly [string, string]> {
  const mod = isMacPlatform(navigator.platform) ? "⌘" : "Ctrl+";
  return [
    ["Move between rows", "↑ ↓ Home End"],
    ["Open or close a folder", "→ ←"],
    ["Open a file or toggle a folder", "Enter, Space"],
    ["Select a range or another row", `Shift+↑↓, Shift-click, ${mod}click`],
    ["Search by typing a letter", "a–z"],
  ];
}

/**
 * Lists the Files panel and file view shortcuts with their current keys, so a rebind
 * in Settings shows up here. Built-in tree keys are listed but are not rebindable.
 */
export function FileShortcutsHelp() {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  type="button"
                  variant="ghost-muted"
                  size="icon-xs"
                  aria-label="File keyboard shortcuts"
                />
              }
            />
          }
        >
          <MorphIcon className="size-3.5" icon={Keyboard} />
        </TooltipTrigger>
        <TooltipPopup>Keyboard shortcuts</TooltipPopup>
      </Tooltip>
      <PopoverPopup width="md" padding="compact" align="end">
        <PopoverTitle className="mb-2">File shortcuts</PopoverTitle>
        <dl
          className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-xs"
          aria-label="File shortcuts"
        >
          {builtInRows().map(([label, keys]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="font-medium">{keys}</dd>
            </div>
          ))}
          {COMMAND_ROWS.map(([command, label]) => (
            <div key={command} className="contents" data-command={command}>
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="font-medium">
                {fileViewShortcutLabel(keybindings, command) ?? "Not set"}
              </dd>
            </div>
          ))}
        </dl>
      </PopoverPopup>
    </Popover>
  );
}
