import type { KeybindingShortcut } from "@goat/contracts";
import { formatShortcutKeyParts } from "../../keybindings";
import { Kbd, KbdGroup } from "../ui/kbd";

export function KeybindingPill({ shortcut }: { shortcut: KeybindingShortcut }) {
  const parts = formatShortcutKeyParts(shortcut);
  return (
    <KbdGroup>
      {parts.map((part, index) => (
        <Kbd key={index === parts.length - 1 ? "key" : part}>{part}</Kbd>
      ))}
    </KbdGroup>
  );
}
