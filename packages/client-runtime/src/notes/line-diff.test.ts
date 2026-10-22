import { describe, expect, it } from "@effect/vitest";
import { diffNoteLines } from "./line-diff.ts";

describe("note line diff", () => {
  it("handles empty versions, additions and removals", () => {
    expect(diffNoteLines("", "")).toEqual({ phone: [], hub: [], wholeBlock: false });
    expect(diffNoteLines("new", "").phone).toEqual([{ text: "new", kind: "added" }]);
    expect(diffNoteLines("", "old").hub).toEqual([{ text: "old", kind: "removed" }]);
  });

  it("preserves blank lines, trailing newlines, whitespace, CRLF and Unicode", () => {
    const body = "# 메모 🐐\r\n\n  task\t\n";
    const diff = diffNoteLines(body, body);
    expect(diff.phone.map((line) => line.text).join("\n")).toBe(body);
    expect(diff.phone.every((line) => line.kind === "unchanged")).toBe(true);
    expect(diff.hub).toEqual(diff.phone);
    expect(diffNoteLines("task ", "task").phone[0]?.kind).toBe("added");
    expect(diffNoteLines("task\n", "task").phone.at(-1)).toEqual({ text: "", kind: "added" });
  });

  it("aligns repeated lines using the longest common subsequence", () => {
    const diff = diffNoteLines("A\nB\nA\nC", "A\nA\nB\nC");
    expect(diff.phone.filter((line) => line.kind === "unchanged").map((line) => line.text)).toEqual(
      ["A", "A", "C"],
    );
    expect(diff.hub.filter((line) => line.kind === "unchanged").map((line) => line.text)).toEqual([
      "A",
      "A",
      "C",
    ]);
    expect(diff.phone.filter((line) => line.kind === "added")).toEqual([
      { text: "B", kind: "added" },
    ]);
    expect(diff.hub.filter((line) => line.kind === "removed")).toEqual([
      { text: "B", kind: "removed" },
    ]);
  });

  it.each([
    ["matrix budget", Array(500).fill("phone").join("\n"), Array(500).fill("hub").join("\n")],
    ["line budget", "phone\n".repeat(2001), "hub"],
    ["character budget", "x".repeat(128001), "hub"],
  ])("falls back to complete blocks at the %s", (_, phone, hub) => {
    expect(diffNoteLines(phone, hub)).toEqual({
      phone: [{ text: phone, kind: "added" }],
      hub: [{ text: hub, kind: "removed" }],
      wholeBlock: true,
    });
  });

  it("does not highlight identical oversized blocks as changed", () => {
    const body = "same\n".repeat(2001);
    const diff = diffNoteLines(body, body);
    expect(diff.wholeBlock).toBe(true);
    expect(diff.phone).toEqual([{ text: body, kind: "unchanged" }]);
    expect(diff.hub).toEqual(diff.phone);
  });

  it("highlights replacements while leaving shared context intact", () => {
    const diff = diffNoteLines("# Note\n- [x] task\nend", "# Note\n- [ ] task\nend");
    expect(diff.phone).toEqual([
      { text: "# Note", kind: "unchanged" },
      { text: "- [x] task", kind: "added" },
      { text: "end", kind: "unchanged" },
    ]);
    expect(diff.hub).toEqual([
      { text: "# Note", kind: "unchanged" },
      { text: "- [ ] task", kind: "removed" },
      { text: "end", kind: "unchanged" },
    ]);
  });
});
