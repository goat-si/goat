import type { ReactNode } from "react";
import type { SearchOverlayMode } from "./CommandPalette.logic";
import { CommandPaletteDialogFrame } from "./CommandPaletteDialogFrame";
import { ProjectFilePicker } from "./files/ProjectFilePicker";
import { ProjectContentSearchDialog } from "./search/ProjectContentSearchDialog";

export function CommandPaletteDialog(props: {
  mode: SearchOverlayMode;
  setOpen: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <CommandPaletteDialogFrame mode={props.mode} setOpen={props.setOpen}>
      {props.mode === "files" ? (
        <ProjectFilePicker setOpen={props.setOpen} />
      ) : props.mode === "content" ? (
        <ProjectContentSearchDialog onOpenChange={props.setOpen} />
      ) : (
        props.children
      )}
    </CommandPaletteDialogFrame>
  );
}
