import { describe, expect, it } from "vite-plus/test";

import { goatBotPreviewText } from "./goatBotPreviewText.ts";

describe("goatBotPreviewText reads a message as one plain line", () => {
  it.each([
    ["## Status\n\n**Done.** The *flaky* test passes.", "Status Done. The flaky test passes."],
    ["- first\n- second\n1. third\n- [x] fourth", "first second third fourth"],
    ["See [PR #42](https://github.com/a/b/pull/42) and ![shot](a.png)", "See PR #42 and shot"],
    ["Run `vp test` then:\n```sh\nvp run dev\n```", "Run vp test then: vp run dev"],
    ["> quoted ~~old~~ new\n\n---\n\nafter", "quoted old new after"],
    ["| File | State |\n| --- | --- |\n| a.ts | ok |", "File State a.ts ok"],
    [
      "Keep snake_case_names and 2 * 3 = 6 and \\*stars\\*",
      "Keep snake_case_names and 2 * 3 = 6 and *stars*",
    ],
    ["Visit <https://goat.si> __now__", "Visit https://goat.si now"],
  ])("%j", (markdown, plain) => {
    expect(goatBotPreviewText(markdown)).toBe(plain);
  });
});
