import type { KeybindingShortcut } from "@goat/contracts";
import { shortcutToKeybindingParts } from "./KeybindingsSettings.logic";
import { Kbd, KbdGroup } from "../ui/kbd";

export function KeybindingPill({ shortcut }: { shortcut: KeybindingShortcut }) {
  const isMac = navigator.platform.toLowerCase().includes("mac");
  const parts = shortcutToKeybindingParts(shortcut);
  const modifierParts = parts.slice(0, -1);
  const keyPart = parts.at(-1);

  return (
    <KbdGroup>
      {modifierParts.map((part) => (
        <Kbd key={part}>
          {part === "mod"
            ? isMac
              ? "⌘"
              : "Ctrl"
            : part === "shift"
              ? "⇧"
              : part === "alt"
                ? isMac
                  ? "⌥"
                  : "Alt"
                : part === "ctrl"
                  ? "⌃"
                  : part}
        </Kbd>
      ))}
      {keyPart !== undefined ? (
        <Kbd key="key">{keyPart.length === 1 ? keyPart.toUpperCase() : keyPart}</Kbd>
      ) : null}
    </KbdGroup>
  );
}
