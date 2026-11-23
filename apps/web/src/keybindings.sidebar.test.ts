import { assert, describe, it } from "vite-plus/test";
import { isSidebarToggleShortcut, type ShortcutEventLike } from "./keybindings";

const DEFAULT_BINDINGS = [{ command: "sidebar.toggle" as const, shortcut: { key: "b", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, modKey: true } }];
function event(overrides: Partial<ShortcutEventLike>): ShortcutEventLike {
  return { key: "j", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...overrides };
}

describe("isSidebarToggleShortcut", () => {
  it("leaves Ctrl+B to a focused terminal, where it is the tmux prefix", () => {
    const ctrlB = event({ key: "b", ctrlKey: true });
    assert.isFalse(
      isSidebarToggleShortcut(ctrlB, DEFAULT_BINDINGS, {
        platform: "Linux",
        context: { terminalFocus: true },
      }),
    );
    assert.isTrue(
      isSidebarToggleShortcut(ctrlB, DEFAULT_BINDINGS, {
        platform: "Linux",
        context: { terminalFocus: false },
      }),
    );
  });

  it("keeps Cmd+B toggling the sidebar from a focused terminal on macOS", () => {
    assert.isTrue(
      isSidebarToggleShortcut(event({ key: "b", metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
    );
  });
});

