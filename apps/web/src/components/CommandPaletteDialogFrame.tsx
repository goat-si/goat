import type { ReactNode } from "react";
import { useComposerHandleContext } from "../composerHandleContext";
import { cn } from "../lib/utils";
import { CommandDialogPopup } from "./ui/command";

export function CommandPaletteDialogFrame(props: {
  mode: "command" | "files" | "content";
  setOpen: (open: boolean) => void;
  children: ReactNode;
}) {
  const composerHandleRef = useComposerHandleContext();
  return (
    <CommandDialogPopup
      aria-label={
        props.mode === "files"
          ? "File picker"
          : props.mode === "content"
            ? "Search project contents"
            : "Command palette"
      }
      className={cn("overflow-hidden", props.mode === "content" && "h-105")}
      data-command-palette="true"
      data-palette-mode={props.mode}
      data-testid="command-palette"
      finalFocus={() => {
        const composer = composerHandleRef?.current;
        if (!composer) return true;
        composer.focusAtEnd();
        return false;
      }}
      onBackdropPointerDown={() => props.setOpen(false)}
    >
      {props.children}
    </CommandDialogPopup>
  );
}
