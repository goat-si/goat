import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectReadFileResult, ScopedThreadRef } from "@goat/contracts";
import {
  resolveEditorCommandFromKeyboardEvent,
  resolveFindAgainShortcut,
} from "@pierre/diffs/edit";
import { useEffect, useRef, useState } from "react";

import { Copy } from "~/components/solar/nodes";
import { MorphIcon } from "~/components/MorphIcon";
import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuShortcut, MenuTrigger } from "~/components/ui/menu";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useFileContextMenu } from "~/fileContextMenu";
import { copyFilePath, resolveFilePathCopyTargets } from "~/filePathCopy";
import { useStableCallback } from "~/hooks/useStableCallback";
import { isTextFieldFocused } from "~/lib/editableFocus";
import { isMacPlatform } from "~/lib/utils";
import { useRightPanelStore } from "~/rightPanelStore";
import { primaryServerKeybindingsAtom } from "~/state/server";

import { copyFileContents, copyFileNames } from "./fileContentsCopy";
import { sourceEditorContent } from "./sourceEditorContent";
import { FileGoToLine } from "./FileGoToLine";
import { copyFilePathsForCommand } from "./filePathCopyShortcut";
import { FileShortcutsHelp } from "./FileShortcutsHelp";
import { FILE_TREE_FOCUS_REQUEST } from "./fileTreeShortcuts";
import {
  FILE_ITEM_COMMANDS,
  fileViewCommandForEvent,
  fileViewShortcutLabel,
  type FileViewCommand,
} from "./fileViewCommands";

const VIEW_COMMANDS: readonly FileViewCommand[] = [
  ...FILE_ITEM_COMMANDS,
  "files.find",
  "files.goToLine",
];

function editorFindOpen(content: HTMLElement): boolean {
  const root = content.getRootNode();
  return (
    root instanceof ShadowRoot &&
    root.querySelector("[data-search-panel] input[data-search]") !== null
  );
}

/**
 * Pierre handles find-next on its text only, and only while its find bar is open
 * (Cmd+G on macOS, Ctrl+G elsewhere). There that key stays find-next.
 */
export function keepsEditorFindAgain(
  event: KeyboardEvent,
  where: { readonly inEditor: boolean; readonly findOpen: boolean; readonly isMac: boolean },
): boolean {
  return (
    where.inEditor && where.findOpen && resolveFindAgainShortcut(event, where.isMac) !== undefined
  );
}

/**
 * The open file's header actions and its keyboard shortcuts. Shortcuts act while focus
 * is anywhere in its view ([data-file-view]); the Files panel inside the view handles
 * its own rows in its own capture listener.
 */
export function FileViewMenu(props: {
  filePath: string;
  workspaceRoot: string;
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef;
  /** The file's read, or null for a folder or media. */
  readResult: ProjectReadFileResult | null;
  onRefresh?: (() => void) | undefined;
}) {
  const { relativePath, fullPath } = resolveFilePathCopyTargets(props);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const fileContextMenu = useFileContextMenu(props.environmentId);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [goToLineOpen, setGoToLineOpen] = useState(false);
  const view = () => triggerRef.current?.closest<HTMLElement>("[data-file-view]") ?? null;
  const focusView = () => {
    const element = view();
    if (element) (sourceEditorContent(element) ?? element).focus();
  };
  const copyContents = () =>
    props.readResult === null
      ? toastManager.add({ type: "error", title: "Open a text file to copy its contents" })
      : copyFileContents(props.filePath, { _tag: "Success", value: props.readResult });
  const reveal = () =>
    fileContextMenu.capabilities.revealLabel === undefined
      ? toastManager.add({ type: "error", title: "Reveal is not available on this environment" })
      : fileContextMenu.activate("reveal-in-folder", {
          environmentId: props.environmentId,
          filePath: props.filePath,
          workspaceRoot: props.workspaceRoot,
        });
  // Capture runs before Pierre's editor handles its own keys, so a file command bound to
  // one of them still runs; the editor's find and find-next keep theirs (below).
  const handleShortcut = useStableCallback((event: KeyboardEvent) => {
    if (event.isComposing || isTextFieldFocused(event.target)) return;
    const path = event.composedPath();
    const fromTree = path.some(
      (node) => node instanceof Element && node.hasAttribute("data-file-browser-panel"),
    );
    if (fromTree) return;
    const command = fileViewCommandForEvent(event, keybindings, VIEW_COMMANDS);
    if (command === null) return;
    const element = view();
    const content = element === null ? null : sourceEditorContent(element);
    const inEditor = content !== null && path.includes(content);
    const mac = isMacPlatform(navigator.platform);
    if (command === "files.goToLine") {
      if (props.readResult === null) return;
      const findOpen = content !== null && editorFindOpen(content);
      if (keepsEditorFindAgain(event, { inEditor, findOpen, isMac: mac })) return;
    }
    if (command === "files.find") {
      // Read-only and rendered views have no in-app find; thread or browser find keeps the key.
      if (content === null) return;
      if (
        inEditor &&
        resolveEditorCommandFromKeyboardEvent(event, undefined, mac) === "openSearchPanel"
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      content.focus();
      // The editor has no API to open its find, so send it its own key. A non-composed
      // event stays inside the editor's shadow root: no window listener sees it.
      content.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "f",
          code: "KeyF",
          metaKey: mac,
          ctrlKey: !mac,
          bubbles: true,
          cancelable: true,
          composed: false,
        }),
      );
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;
    if (command === "files.copyPath" || command === "files.copyRelativePath") {
      void copyFilePathsForCommand(command, [props.filePath], props.workspaceRoot);
    } else if (command === "files.copyName") {
      void copyFileNames([props.filePath]);
    } else if (command === "files.copyContents") {
      void copyContents();
    } else if (command === "files.revealInFileManager") {
      void reveal();
    } else if (command === "files.refresh") {
      props.onRefresh?.();
    } else if (command === "files.toggleFocus") {
      element
        ?.querySelector("[data-file-browser-panel]")
        ?.dispatchEvent(new CustomEvent(FILE_TREE_FOCUS_REQUEST));
    } else if (command === "files.goToLine") {
      setGoToLineOpen(true);
    }
  });
  useEffect(() => {
    const element = triggerRef.current?.closest<HTMLElement>("[data-file-view]");
    if (!element) return;
    element.addEventListener("keydown", handleShortcut, true);
    return () => element.removeEventListener("keydown", handleShortcut, true);
  }, [handleShortcut]);
  const label = (command: FileViewCommand) => fileViewShortcutLabel(keybindings, command);
  const item = (command: FileViewCommand, text: string, run: () => void) => {
    const shortcut = label(command);
    return (
      <MenuItem onClick={run}>
        {text}
        {shortcut ? <MenuShortcut>{shortcut}</MenuShortcut> : null}
      </MenuItem>
    );
  };
  return (
    <>
      {goToLineOpen && props.readResult !== null ? (
        <FileGoToLine
          contents={props.readResult.contents}
          shortcut={label("files.goToLine")}
          onSubmit={(line) => {
            setGoToLineOpen(false);
            useRightPanelStore.getState().openFile(props.threadRef, props.filePath, line);
            focusView();
          }}
          onClose={() => {
            setGoToLineOpen(false);
            focusView();
          }}
        />
      ) : null}
      <FileShortcutsHelp />
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
            <div className="text-muted-foreground">
              Relative paths start at {props.workspaceRoot}
            </div>
          </TooltipPopup>
        </Tooltip>
        <MenuPopup align="end">
          {relativePath !== null
            ? item(
                "files.copyRelativePath",
                "Copy relative path",
                () => void copyFilePath(relativePath, "Relative path"),
              )
            : null}
          {fullPath !== null
            ? item(
                "files.copyPath",
                "Copy full path",
                () => void copyFilePath(fullPath, "Full path"),
              )
            : null}
          {item("files.copyName", "Copy name", () => void copyFileNames([props.filePath]))}
          {props.readResult !== null
            ? item("files.copyContents", "Copy contents", () => void copyContents())
            : null}
        </MenuPopup>
      </Menu>
    </>
  );
}
