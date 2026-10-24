import { useAtomValue } from "@effect/atom-react";
import { useEffect, useRef } from "react";

import { Copy } from "~/components/solar/nodes";
import { MorphIcon } from "~/components/MorphIcon";
import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuShortcut, MenuTrigger } from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { copyFilePath, resolveFilePathCopyTargets } from "~/filePathCopy";
import { useStableCallback } from "~/hooks/useStableCallback";
import { primaryServerKeybindingsAtom } from "~/state/server";

import {
  copyFilePathsForCommand,
  filePathCopyCommandForEvent,
  filePathCopyShortcutLabel,
} from "./filePathCopyShortcut";

/**
 * Path copying stays available even when no editor or shell actions are supported.
 * The copy shortcuts act on this file while focus is in its view; the file tree
 * inside the view handles its own rows and stops those events.
 */
export function FilePathCopyMenu(props: { filePath: string; workspaceRoot: string }) {
  const { relativePath, fullPath } = resolveFilePathCopyTargets(props);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const copyFromShortcut = useStableCallback((event: KeyboardEvent) => {
    const command = filePathCopyCommandForEvent(event, keybindings);
    if (command === null) return;
    event.preventDefault();
    if (!event.repeat) void copyFilePathsForCommand(command, [props.filePath], props.workspaceRoot);
  });
  useEffect(() => {
    const view = triggerRef.current?.closest<HTMLElement>("[data-file-view]");
    if (!view) return;
    view.addEventListener("keydown", copyFromShortcut);
    return () => view.removeEventListener("keydown", copyFromShortcut);
  }, [copyFromShortcut]);
  const relativeShortcut = filePathCopyShortcutLabel(keybindings, "files.copyRelativePath");
  const fullShortcut = filePathCopyShortcutLabel(keybindings, "files.copyPath");
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              ref={triggerRef}
              render={<Button variant="ghost-muted" size="icon-sm" aria-label="Copy file path" />}
            />
          }
        >
          <MorphIcon className="size-3.5" icon={Copy} />
        </TooltipTrigger>
        <TooltipPopup>
          <div>Copy path</div>
          <div className="text-muted-foreground">Relative paths start at {props.workspaceRoot}</div>
        </TooltipPopup>
      </Tooltip>
      <MenuPopup align="end">
        {relativePath !== null ? (
          <MenuItem onClick={() => void copyFilePath(relativePath, "Relative path")}>
            Copy relative path
            {relativeShortcut ? <MenuShortcut>{relativeShortcut}</MenuShortcut> : null}
          </MenuItem>
        ) : null}
        {fullPath !== null ? (
          <MenuItem onClick={() => void copyFilePath(fullPath, "Full path")}>
            Copy full path
            {fullShortcut ? <MenuShortcut>{fullShortcut}</MenuShortcut> : null}
          </MenuItem>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}
