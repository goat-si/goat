import { assert, describe, it } from "vite-plus/test";
import type {
  KeybindingShortcut,
  KeybindingCommand,
  ResolvedKeybindingsConfig,
} from "@goat/contracts";
import { resolveShortcutCommand, type ShortcutEventLike } from "./keybindings";

function event(overrides: Partial<ShortcutEventLike> = {}): ShortcutEventLike {
  return { key: "j", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...overrides };
}
function modShortcut(
  key: string,
  overrides: Partial<Omit<KeybindingShortcut, "key">> = {},
): KeybindingShortcut {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    modKey: true,
    ...overrides,
  };
}
function compile(
  bindings: { shortcut: KeybindingShortcut; command: KeybindingCommand }[],
): ResolvedKeybindingsConfig {
  return bindings;
}

describe("keyboard layout shortcuts", () => {
  it("matches Option symbols against the active Latin layout rather than the US position", () => {
    const keybindings = compile([
      { shortcut: modShortcut("a", { altKey: true, shiftKey: true }), command: "appearance.cycle" },
      { shortcut: modShortcut("q", { altKey: true, shiftKey: true }), command: "sidebar.toggle" },
    ]);
    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "Æ", code: "KeyQ", metaKey: true, altKey: true, shiftKey: true }),
        keybindings,
        { platform: "MacIntel", keyboardLayoutMap: new Map([["KeyQ", "a"]]) },
      ),
      "appearance.cycle",
    );
  });

  it("preserves physical punctuation alongside an Option-modified mapped letter", () => {
    for (const key of [";", "m"]) {
      const keybindings = compile([
        { shortcut: modShortcut(key, { altKey: true }), command: "diff.toggle" },
      ]);
      assert.strictEqual(
        resolveShortcutCommand(
          event({ key: "µ", code: "Semicolon", metaKey: true, altKey: true }),
          keybindings,
          { platform: "MacIntel", keyboardLayoutMap: new Map([["Semicolon", "m"]]) },
        ),
        "diff.toggle",
      );
    }
  });

  it("keeps Latin event keys and unsupported layout fallbacks", () => {
    const keybindings = compile([
      { shortcut: modShortcut("a", { altKey: true }), command: "appearance.cycle" },
      { shortcut: modShortcut("q", { altKey: true }), command: "sidebar.toggle" },
    ]);
    const options = { platform: "MacIntel", keyboardLayoutMap: new Map([["KeyQ", "a"]]) };
    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "q", code: "KeyQ", metaKey: true, altKey: true }),
        keybindings,
        options,
      ),
      "sidebar.toggle",
    );
    for (const keyboardLayoutMap of [new Map<string, string>(), new Map([["KeyQ", "й"]])]) {
      assert.strictEqual(
        resolveShortcutCommand(
          event({ key: "Æ", code: "KeyQ", metaKey: true, altKey: true }),
          keybindings,
          { ...options, keyboardLayoutMap },
        ),
        "sidebar.toggle",
      );
    }
    assert.strictEqual(
      resolveShortcutCommand(
        event({
          key: "Æ",
          code: "KeyQ",
          ctrlKey: true,
          altKey: true,
          getModifierState: () => true,
        }),
        keybindings,
        { ...options, platform: "Win32" },
      ),
      null,
    );
  });
});
