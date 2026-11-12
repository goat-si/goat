import { DEFAULT_RESOLVED_KEYBINDINGS } from "@goat/shared/keybindings";
import { expect, it } from "vite-plus/test";
import { resolveShortcutCommand } from "../../keybindings";

it("resolves the next ask shortcut outside the terminal", () => {
  const event = { key: "j", metaKey: true, ctrlKey: false, altKey: true, shiftKey: true };
  expect(
    resolveShortcutCommand(event, DEFAULT_RESOLVED_KEYBINDINGS, {
      platform: "MacIntel",
      context: { terminalFocus: false },
    }),
  ).toBe("goatBot.nextAsk");
  expect(
    resolveShortcutCommand(event, DEFAULT_RESOLVED_KEYBINDINGS, {
      platform: "MacIntel",
      context: { terminalFocus: true },
    }),
  ).not.toBe("goatBot.nextAsk");
});
