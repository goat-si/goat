import { assert, it } from "vite-plus/test";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@goat/shared/keybindings";
import type {
  KeybindingCommand,
  KeybindingShortcut,
  ResolvedKeybindingsConfig,
} from "@goat/contracts";
import { resolveShortcutCommand, type ShortcutEventLike } from "./keybindings";

function event(overrides: Partial<ShortcutEventLike>): ShortcutEventLike {
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

it('matches Ctrl+layout "+" as itself unless Shift, Alt or the number row is involved', () => {
  assert.isNull(
    resolveShortcutCommand(
      event({ key: "+", code: "BracketRight", ctrlKey: true }),
      DEFAULT_RESOLVED_KEYBINDINGS,
      { platform: "Linux", context: { terminalFocus: false } },
    ),
  );
  assert.strictEqual(
    resolveShortcutCommand(
      event({ key: "+", code: "Minus", ctrlKey: true }),
      DEFAULT_RESOLVED_KEYBINDINGS,
      { platform: "Linux", context: { previewFocus: true } },
    ),
    "preview.zoomIn",
  );
  assert.strictEqual(
    resolveShortcutCommand(
      event({ key: "+", code: "Digit1", ctrlKey: true }),
      DEFAULT_RESOLVED_KEYBINDINGS,
      { platform: "Linux", context: { isDesktop: true } },
    ),
    "thread.jump.1",
  );
  assert.strictEqual(
    resolveShortcutCommand(
      event({ key: "+", code: "BracketRight", altKey: true }),
      compile([
        {
          shortcut: modShortcut("]", { modKey: false, altKey: true }),
          command: "terminal.toggle",
        },
      ]),
      { platform: "Linux" },
    ),
    "terminal.toggle",
  );
  assert.strictEqual(
    resolveShortcutCommand(
      event({ key: "+", code: "Equal", ctrlKey: true, shiftKey: true }),
      compile([{ shortcut: modShortcut("=", { shiftKey: true }), command: "terminal.toggle" }]),
      { platform: "Linux" },
    ),
    "terminal.toggle",
  );
});
