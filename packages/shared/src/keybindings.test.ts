import { describe, expect, it } from "vite-plus/test";

import {
  compileResolvedKeybindingsConfig,
  DEFAULT_KEYBINDINGS,
  matchesKeybindingShortcut,
  mergeWithDefaultKeybindings,
  parseKeybindingShortcut,
} from "./keybindings.js";

describe("sidebar activity keybinding", () => {
  it.each([
    { platform: "MacIntel", metaKey: true, ctrlKey: false, key: "¨" },
    { platform: "Win32", metaKey: false, ctrlKey: true, key: "u" },
    { platform: "Linux", metaKey: false, ctrlKey: true, key: "u" },
  ])("resolves mod+alt+u on $platform", ({ platform, metaKey, ctrlKey, key }) => {
    const bindings = compileResolvedKeybindingsConfig(DEFAULT_KEYBINDINGS);
    const matching = bindings.filter((binding) =>
      matchesKeybindingShortcut(
        {
          key,
          code: "KeyU",
          metaKey,
          ctrlKey,
          altKey: true,
          shiftKey: false,
        },
        binding.shortcut,
        platform,
      ),
    );
    expect(matching.map((binding) => binding.command)).toEqual(["sidebar.toggleActivity"]);
  });

  it("adds the activity shortcut to an older custom configuration", () => {
    const bindings = mergeWithDefaultKeybindings(
      compileResolvedKeybindingsConfig([{ key: "mod+shift+b", command: "sidebar.toggle" }]),
    );
    expect(
      bindings.find((binding) => binding.command === "sidebar.toggleActivity")?.shortcut,
    ).toEqual(parseKeybindingShortcut("mod+alt+u"));
  });

  it("honors a custom activity shortcut without retaining the default", () => {
    const bindings = mergeWithDefaultKeybindings(
      compileResolvedKeybindingsConfig([{ key: "mod+shift+u", command: "sidebar.toggleActivity" }]),
    );
    expect(
      bindings
        .filter((binding) => binding.command === "sidebar.toggleActivity")
        .map((binding) => binding.shortcut),
    ).toEqual([parseKeybindingShortcut("mod+shift+u")]);
  });
});
