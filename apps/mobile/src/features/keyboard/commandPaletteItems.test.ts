import { describe, expect, it } from "vite-plus/test";

import { filterCommandPaletteItems, type CommandPaletteItem } from "./commandPaletteItems";

function item(
  key: string,
  title: string,
  kind: CommandPaletteItem["kind"],
  searchTerms: string[] = [],
): CommandPaletteItem {
  return { key, title, kind, searchTerms, run: () => {} };
}

const items = [
  item("new", "New thread in…", "action", ["project", "create"]),
  item("settings", "Open settings", "action", ["preferences"]),
  item("project", "Mobile app", "project", ["/workspaces/mobile", "new thread"]),
  item("siva:one", "Keyboard shortcuts", "thread", ["Mobile app", "Siva"]),
  item("mac:one", "Mobile app", "thread", ["Mac"]),
];
const emptyMatches = new Set<string>();

describe("filterCommandPaletteItems", () => {
  it("matches query tokens across titles and metadata and ranks exact titles first", () => {
    expect(
      filterCommandPaletteItems(items, " MOBILE app ", emptyMatches).map((item) => item.key),
    ).toEqual(["project", "mac:one", "siva:one"]);
    expect(
      filterCommandPaletteItems(items, "siva keyboard", emptyMatches).map((item) => item.key),
    ).toEqual(["siva:one"]);
  });

  it("includes server content matches scoped to the correct environment, except in actions-only mode", () => {
    const matches = new Set(["siva:one", "project"]);
    expect(
      filterCommandPaletteItems(items, "message content", matches).map((item) => item.key),
    ).toEqual(["siva:one"]);
    expect(filterCommandPaletteItems(items, "> message content", matches)).toEqual([]);
  });
});

// Memory uses the existing palette/keybinding path; aliases never perform mutations.
import { memoryPaletteItem } from "./commandPaletteItems";
it("finds memory management aliases and opens only when selected", () => {
  let opens = 0;
  const item = memoryPaletteItem(() => {
    opens++;
  });
  for (const alias of ["forget", "conflict", "revert", "sync", "import"]) {
    expect(filterCommandPaletteItems([item], `>${alias}`, new Set())).toEqual([item]);
  }
  expect(opens).toBe(0);
  item.run();
  expect(opens).toBe(1);
});
