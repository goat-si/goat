import { describe, expect, it } from "@effect/vitest";

import {
  claudeFileChangeLineCounts,
  codexFileChangeLineCounts,
  countUnifiedDiffLines,
} from "./fileChangeLineCounts.ts";

describe("countUnifiedDiffLines", () => {
  it("sums every file of a git patch and skips its file headers", () => {
    const patch = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 1111111..2222222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,2 +1,3 @@",
      " keep",
      "-old",
      "+new",
      "+added",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "@@ -4,2 +4,0 @@",
      "--- a removed line that looks like a header",
      "-gone",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    expect(countUnifiedDiffLines(patch)).toEqual({ additions: 2, deletions: 3 });
  });

  it.each(["@@ -1,1 +1,1 @@", "@@ -1 +1 @@"])(
    "counts header-like changes inside a hunk with header %s",
    (header) => {
      const patch = [
        "diff --git a/example.txt b/example.txt",
        "--- a/example.txt",
        "+++ b/example.txt",
        header,
        "--- old",
        "+++ new",
        "",
      ].join("\n");
      expect(countUnifiedDiffLines(patch)).toEqual({ additions: 1, deletions: 1 });
    },
  );

  it("distinguishes header-like changes from the next file's headers", () => {
    const patch = [
      "diff --git a/first.txt b/first.txt",
      "--- a/first.txt",
      "+++ b/first.txt",
      "@@ -1,2 +1,2 @@",
      " keep",
      "--- old",
      "+++ new",
      "diff --git a/second.txt b/second.txt",
      "--- a/second.txt",
      "+++ b/second.txt",
      "@@ -0,0 +1 @@",
      "+added",
      "",
    ].join("\n");
    expect(countUnifiedDiffLines(patch)).toEqual({ additions: 2, deletions: 1 });
  });

  it("reports nothing for text that is not a diff", () => {
    expect(countUnifiedDiffLines("Error: old_string not found in file")).toBeUndefined();
    expect(countUnifiedDiffLines("+looks like an add\n-but has no hunk\n")).toBeUndefined();
  });
});

describe("codexFileChangeLineCounts", () => {
  it("counts created and deleted files by their content and updates by their diff", () => {
    expect(
      codexFileChangeLineCounts([
        { kind: { type: "add" }, diff: "one\ntwo\nthree\n" },
        { kind: { type: "delete" }, diff: "gone\n" },
        { kind: { type: "update" }, diff: "@@ -1 +1,2 @@\n-a\n+b\n+c\n" },
        { kind: { type: "update" }, diff: "" },
      ]),
    ).toEqual({ additions: 5, deletions: 2 });
  });

  it("reports nothing when an update is not a diff", () => {
    expect(
      codexFileChangeLineCounts([{ kind: { type: "update" }, diff: "unexpected text" }]),
    ).toBeUndefined();
  });
});

describe("claudeFileChangeLineCounts", () => {
  it("counts structuredPatch hunks from an Edit result", () => {
    expect(
      claudeFileChangeLineCounts({
        filePath: "/repo/src/a.ts",
        structuredPatch: [
          { oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [" a", "-b", "+c", "+d"] },
        ],
      }),
    ).toEqual({ additions: 2, deletions: 1 });
  });

  it("counts a created file's content when its patch is empty", () => {
    expect(
      claudeFileChangeLineCounts({
        type: "create",
        filePath: "/repo/new.ts",
        content: "a\nb\n",
        structuredPatch: [],
        originalFile: null,
      }),
    ).toEqual({ additions: 2, deletions: 0 });
  });

  it("reports nothing when the write was staged or its diff is unknown", () => {
    expect(
      claudeFileChangeLineCounts({
        staged: true,
        structuredPatch: [{ lines: ["+held for review"] }],
      }),
    ).toBeUndefined();
    expect(
      claudeFileChangeLineCounts({ type: "update", content: "x\n", structuredPatch: [] }),
    ).toBeUndefined();
  });
});
