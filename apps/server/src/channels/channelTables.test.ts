import { describe, expect, it } from "vite-plus/test";

import { markdownTablesToLists } from "./channelTables.ts";

const plain = { bullet: "•", boldFirst: false } as const;

describe("markdownTablesToLists", () => {
  it("keeps a malformed table as written", () => {
    const extraCell = "| a | b |\n| - | - |\n| 1 | 2 | 3 |";
    const noDelimiter = "| a | b |\n| 1 | 2 |";
    expect(markdownTablesToLists(extraCell, plain)).toBe(extraCell);
    expect(markdownTablesToLists(noDelimiter, plain)).toBe(noDelimiter);
  });

  it("keeps escaped pipes in a cell, skips empty cells and lists a single column plainly", () => {
    expect(
      markdownTablesToLists("| Cmd | Note |\n|---|---|\n| a \\| b | |\n| c | done |", plain),
    ).toBe("• a | b\n• c (Note: done)");
    expect(markdownTablesToLists("| Step |\n|---|\n| Build |", plain)).toBe("• Build");
  });
});
