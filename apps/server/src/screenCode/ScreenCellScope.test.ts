import { describe, expect, it } from "vite-plus/test";

import { topLevelBindings } from "./ScreenCellScope.ts";

describe("top-level bindings a cell carries into the next cell", () => {
  it.each([
    [
      "destructuring and functions",
      "const a = 1; let { b, c: d, ...e } = x; var [f] = y\nfunction g() {}\nclass K {}",
      ["a", "b", "d", "e", "f", "g", "K"],
    ],
    [
      "pattern keys and defaults are not bindings",
      "const { [k]: m, n = other.thing, o: { p }, q: [r = s] } = x",
      ["m", "n", "p", "r"],
    ],
    [
      "only var leaves a nested block",
      "if (x) { let inner = 1; var outer = 2 }\nconst after = 3",
      ["outer", "after"],
    ],
    [
      "braces inside strings, regex and templates",
      'const s = "{ let no }"; const r = /[}{]let no/g; const t = `${ { a: 1 }.a } let no`\nconst last = 1',
      ["s", "r", "t", "last"],
    ],
    [
      "lines without semicolons",
      "const tab = await screen.tab({ tabId: 'x' })\nlet count = tab.items.length\nreturn count",
      ["tab", "count"],
    ],
    [
      "a for loop's let and the runtime's own names",
      "for (let i = 0; i < 2; i++) {}\nobj.let = 1\nconst __mine = 1",
      [],
    ],
  ])("%s", (_, source, names) => {
    expect(topLevelBindings(source)).toEqual(names);
  });
});
