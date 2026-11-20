import { expect, it } from "vite-plus/test";
import { compileResolvedKeybindingsConfig } from "@goat/shared/keybindings";
import { resolveShortcutCommand } from "./keybindings";

it("does not consume a disabled shortcut or disable another context", () => {
  const bindings = compileResolvedKeybindingsConfig([
    {
      command: "composer.sendAndNewThread",
      key: "mod+alt+enter",
      when: "composerFocus && !draftThreadRoute",
    },
    { command: "composer.sendBackground", key: "mod+alt+enter", when: "false" },
  ]);
  const event = { key: "Enter", ctrlKey: true, metaKey: false, altKey: true, shiftKey: false };
  expect(
    resolveShortcutCommand(event, bindings, {
      platform: "Linux",
      context: { composerFocus: true, draftThreadRoute: false },
    }),
  ).toBe("composer.sendAndNewThread");
  expect(
    resolveShortcutCommand(event, bindings, {
      platform: "Linux",
      context: { composerFocus: true, draftThreadRoute: true },
    }),
  ).toBeNull();
});
