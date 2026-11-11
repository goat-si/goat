import { describe, expect, it } from "vite-plus/test";

import { markdownTablesToLists, TABLE_GROWTH_LIMIT, TABLE_TEXT_LIMIT } from "./channelTables.ts";

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

  it("reads a malformed block once and keeps it whole, however many header pairs repeat", () => {
    const pairs = "| a | b |\n| - | - |\n".repeat(2_000);
    const text = `${pairs}| ${"x | ".repeat(500)}y |`;
    expect(markdownTablesToLists(text, plain)).toBe(text);
  });

  it("keeps a table as written when its list would grow the reply past the budget", () => {
    const header = `| Name | ${"Long column title ".repeat(10)}|\n|---|---|\n`;
    const big = header + Array.from({ length: 200 }, (_, row) => `| r${row} | v |`).join("\n");
    expect(markdownTablesToLists(big, plain)).toBe(big);
    const small = "| a | b |\n|---|---|\n| 1 | 2 |";
    const many = Array.from({ length: 4_000 }, () => small).join("\n\n");
    const converted = markdownTablesToLists(many, plain);
    expect(converted.length).toBeLessThanOrEqual(many.length + TABLE_GROWTH_LIMIT);
    expect(converted.startsWith("• 1 (b: 2)")).toBe(true);
    const long = `${small}\n${"x".repeat(TABLE_TEXT_LIMIT)}`;
    expect(markdownTablesToLists(long, plain)).toBe(long);
  });

  it("leaves code fences alone until a valid closing fence", () => {
    const table = "| a | b |\n|---|---|\n| 1 | 2 |";
    const three = "\u0060".repeat(3);
    const four = "\u0060".repeat(4);
    const longerOpener = [four + "md", three, table, four].join("\n");
    expect(markdownTablesToLists(longerOpener, plain)).toBe(longerOpener);
    const closerWithText = [three, three + " not a closer", table, three].join("\n");
    expect(markdownTablesToLists(closerWithText, plain)).toBe(closerWithText);
    expect(markdownTablesToLists("~~~\n~~~\n" + table, plain)).toBe("~~~\n~~~\n• 1 (b: 2)");
  });

  it("ends a table at a heading, list or quote that follows it", () => {
    const table = "| a | b |\n|---|---|\n| 1 | 2 |";
    expect(markdownTablesToLists(`${table}\n# A | B`, plain)).toBe("• 1 (b: 2)\n# A | B");
    expect(markdownTablesToLists(`${table}\n- x | y`, plain)).toBe("• 1 (b: 2)\n- x | y");
    expect(markdownTablesToLists(`${table}\n> q | r`, plain)).toBe("• 1 (b: 2)\n> q | r");
  });

  it("keeps a table as written when a pipe sits inside inline code or a link", () => {
    for (const cell of [
      "`a|b`",
      "[a|b](https://x.test)",
      "[a](https://x.test/a|b)",
      "<https://x.test/a|b>",
    ]) {
      const text = `| a | b | c |\n|---|---|---|\n| ${cell} | 2 |`;
      expect(markdownTablesToLists(text, plain)).toBe(text);
    }
    expect(
      markdownTablesToLists("| a | b |\n|---|---|\n| [x](https://x.test) | `q\\|r` |", plain),
    ).toBe("• [x](https://x.test) (b: `q|r`)");
  });
});
