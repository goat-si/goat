import { msg } from "gt-react";
import type { AddProjectCloneFlow } from "./CommandPalette.logic";
import { CommandFooterAction } from "./ui/command";

export function paletteFooterLabel(input: {
  isNew: boolean;
  highlighted: string | null;
  toggleValue: string;
  cloneFlow: AddProjectCloneFlow | null;
  remoteLabel: string | null;
  canSubmitBrowsePath: boolean;
  hasHighlightedBrowseItem: boolean;
}) {
  return input.isNew
    ? input.highlighted === null
      ? msg("Create")
      : input.highlighted === input.toggleValue
        ? msg("Toggle")
        : msg("Select")
    : input.cloneFlow?.step === "repository"
      ? (input.remoteLabel ?? msg("Continue"))
      : !input.canSubmitBrowsePath || input.hasHighlightedBrowseItem
        ? msg("Select")
        : undefined;
}

export function CommandPaletteFooter(input: {
  canOpen: boolean;
  disabled: boolean;
  fileManagerName: string;
  onOpen: () => Promise<void>;
  searching: boolean;
}) {
  return input.canOpen ? (
    <CommandFooterAction
      disabled={input.disabled}
      onClick={() => {
        void input.onOpen();
      }}
    >
      {`Open in ${input.fileManagerName}`}
    </CommandFooterAction>
  ) : input.searching ? (
    <span className="text-muted-foreground text-xs">Searching messages…</span>
  ) : null;
}
