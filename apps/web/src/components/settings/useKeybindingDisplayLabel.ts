import type { KeybindingCommand } from "@goat/contracts";
import { msg, useMessages } from "gt-react";
import { commandLabel } from "./KeybindingsSettings.logic";

const KEYBINDING_DISPLAY_LABELS: Partial<Record<KeybindingCommand, string>> = {
  "commandPalette.toggle": msg("Command Palette: Toggle"),
  "editor.openFavorite": msg("Editor: Open Favorite"),
  "filePicker.toggle": msg("File Picker: Toggle"),
  "projectSearch.toggle": msg("Project Search: Toggle"),
  "rightPanel.close": msg("Right Panel: Close"),
  "rightPanel.new": msg("Right Panel: New"),
};

export function useKeybindingDisplayLabel() {
  const m = useMessages();
  return (command: KeybindingCommand) => {
    const label = KEYBINDING_DISPLAY_LABELS[command];
    return label === undefined ? commandLabel(command) : m(label);
  };
}
