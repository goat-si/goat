import type { KeybindingCommand } from "@goat/contracts";
import { useGT, useMessages } from "gt-react";
import { commandLabel, scriptKeybindingName } from "./KeybindingsSettings.logic";

export function useKeybindingDisplayLabel() {
  const gt = useGT();
  const m = useMessages();
  return (command: KeybindingCommand) => {
    if (command.startsWith("script.")) {
      return gt("Run Script: {name}", { name: scriptKeybindingName(command) });
    }
    if (command.startsWith("thread.jump.")) {
      return gt("Thread: Jump: {number}", { number: command.slice("thread.jump.".length) });
    }
    if (command.startsWith("modelPicker.jump.")) {
      return gt("Model Picker: Jump: {number}", {
        number: command.slice("modelPicker.jump.".length),
      });
    }
    return m(commandLabel(command));
  };
}
