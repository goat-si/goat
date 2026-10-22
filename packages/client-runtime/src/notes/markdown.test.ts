import { describe, expect, it } from "@effect/vitest";
import { toggleNoteCheckbox, type NoteCheckbox } from "./markdown.ts";

describe("note checkbox editing", () => {
  it("toggles only the parser-approved position without rewriting markdown or CRLF", () => {
    const body = "# Plan\r\n\r\n- [ ] first **task**\r\n1. [X] second\r\n";
    const boxes: NoteCheckbox[] = [
      { offset: 13, lineStart: 10, lineEnd: 31, checked: false, label: "first **task**" },
      { offset: 36, lineStart: 32, lineEnd: 46, checked: true, label: "second" },
    ];
    expect(toggleNoteCheckbox(body, 13, boxes)).toBe(
      "# Plan\r\n\r\n- [x] first **task**\r\n1. [X] second\r\n",
    );
    expect(toggleNoteCheckbox(body, 36, boxes)).toBe(
      "# Plan\r\n\r\n- [ ] first **task**\r\n1. [ ] second\r\n",
    );
    expect(toggleNoteCheckbox(body, 0, boxes)).toBe(body);
    expect(toggleNoteCheckbox(body, 999, boxes)).toBe(body);
    expect(toggleNoteCheckbox(body, 13, [])).toBe(body);
  });

  it.each(["- [q] changed", "- { ] changed", "- [ } changed", "- ", ""])(
    "refuses to write when a previously parsed marker no longer exists: %j",
    (body) => {
      const boxes: NoteCheckbox[] = [
        { offset: 3, lineStart: 0, lineEnd: 13, checked: false, label: "changed" },
      ];
      expect(toggleNoteCheckbox(body, 3, boxes)).toBe(body);
    },
  );
});

it.each([
  ["HTML pre", "<pre>\n- [ ] example\n</pre>"],
  ["HTML comment", "<!--\n- [ ] example\n-->"],
  ["five marker spaces", "-     [ ] example"],
  ["plain task", "- [ ] example"],
] as const)("does not write %s without a parser-approved marker", (_name, body) => {
  expect(toggleNoteCheckbox(body, body.indexOf("[ ]") + 1)).toBe(body);
});
