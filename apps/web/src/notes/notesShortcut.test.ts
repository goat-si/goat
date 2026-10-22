import { DEFAULT_RESOLVED_KEYBINDINGS } from "@goat/shared/keybindings";
import type {
  KeybindingCommand,
  KeybindingShortcut,
  ResolvedKeybindingsConfig,
} from "@goat/contracts";
import { assert, describe, it } from "vite-plus/test";

import {
  matchesPageCommand,
  pageCommandShortcutLabel,
  resolveShortcutCommand,
  type ShortcutEventLike,
} from "../keybindings";

const event = (overrides: Partial<ShortcutEventLike>): ShortcutEventLike => ({
  key: "n",
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...overrides,
});
const modShortcut = (key: string): KeybindingShortcut => ({
  key,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  modKey: true,
});
const compile = (
  bindings: ReadonlyArray<{ shortcut: KeybindingShortcut; command: KeybindingCommand }>,
): ResolvedKeybindingsConfig => bindings.map((binding) => ({ ...binding }));

describe("new note shortcut", () => {
  const modN = event({ key: "n", metaKey: true });

  it("creates a note on the Notes page and a thread everywhere else", () => {
    const options = { platform: "MacIntel" } as const;
    assert.strictEqual(
      resolveShortcutCommand(modN, DEFAULT_RESOLVED_KEYBINDINGS, {
        ...options,
        context: { notesPageOpen: true },
      }),
      "notes.new",
    );
    assert.strictEqual(
      resolveShortcutCommand(modN, DEFAULT_RESOLVED_KEYBINDINGS, {
        ...options,
        context: { notesPageOpen: false },
      }),
      "chat.new",
    );
  });

  it("leaves mod+n to the terminal while it has focus on the Notes page", () => {
    assert.strictEqual(
      resolveShortcutCommand(modN, DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "MacIntel",
        context: { notesPageOpen: true, terminalFocus: true },
      }),
      "terminal.new",
    );
  });

  it("still belongs to the Notes page when an upgrade backfilled it ahead of chat.new", () => {
    // The server prepends defaults missing from an existing keybindings.json.
    const notesRule = DEFAULT_RESOLVED_KEYBINDINGS.find((rule) => rule.command === "notes.new")!;
    const others = DEFAULT_RESOLVED_KEYBINDINGS.filter((rule) => rule.command !== "notes.new");
    const backfilled = [notesRule, ...others];
    const options = { platform: "MacIntel", context: { notesPageOpen: true } } as const;
    assert.isTrue(matchesPageCommand(modN, backfilled, "notes.new", options));
    assert.strictEqual(pageCommandShortcutLabel(backfilled, "notes.new", options), "⌘N");
    assert.isFalse(
      matchesPageCommand(modN, backfilled, "notes.new", {
        platform: "MacIntel",
        context: { notesPageOpen: false },
      }),
    );
  });

  it("yields to a later shortcut the person bound themselves", () => {
    const notesRule = DEFAULT_RESOLVED_KEYBINDINGS.find((rule) => rule.command === "notes.new")!;
    const custom = [
      notesRule,
      ...compile([{ shortcut: modShortcut("n"), command: "terminal.toggle" }]),
    ];
    const options = { platform: "MacIntel", context: { notesPageOpen: true } } as const;
    assert.isFalse(matchesPageCommand(modN, custom, "notes.new", options));
    assert.isNull(pageCommandShortcutLabel(custom, "notes.new", options));
  });
});
