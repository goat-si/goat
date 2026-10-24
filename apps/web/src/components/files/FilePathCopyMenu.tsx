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
 * The copy shortcuts act on this file while focus, or the last click, is in its
 * view; the file tree inside the view handles its own rows.
 */
export function FilePathCopyMenu(props: { filePath: string; workspaceRoot: string }) {
  const { relativePath, fullPath } = resolveFilePathCopyTargets(props);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const lastPointerInViewRef = useRef(false);
  const ownsTarget = (target: EventTarget | null) => {
    const view = triggerRef.current?.closest("[data-file-view]");
    if (!view || !(target instanceof Element) || !view.contains(target)) return false;
    return target.closest("[data-file-browser-panel]") === null;
  };
  const rememberPointer = useStableCallback((event: PointerEvent) => {
    lastPointerInViewRef.current = ownsTarget(event.target);
  });
  // Clicking read-only file content focuses nothing, so the key event arrives on the body.
  const copyFromShortcut = useStableCallback((event: KeyboardEvent) => {
    const onBody = event.target === document.body || event.target === document.documentElement;
    if (!(onBody ? lastPointerInViewRef.current : ownsTarget(event.target))) return;
    const command = filePathCopyCommandForEvent(event, keybindings);
    if (command === null) return;
    event.preventDefault();
    if (!event.repeat) void copyFilePathsForCommand(command, [props.filePath], props.workspaceRoot);
  });
  useEffect(() => {
    window.addEventListener("pointerdown", rememberPointer, true);
    window.addEventListener("keydown", copyFromShortcut);
    return () => {
      window.removeEventListener("pointerdown", rememberPointer, true);
      window.removeEventListener("keydown", copyFromShortcut);
    };
  }, [copyFromShortcut, rememberPointer]);
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
