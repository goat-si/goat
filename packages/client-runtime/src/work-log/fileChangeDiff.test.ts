import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import { describe, expect, it } from "vite-plus/test";

import {
  extractFilePatch,
  findPatchFile,
  inlineDiffLineCount,
  resolveFileDiffPath,
  resolveFileDiffPreviousPath,
} from "./fileChangeDiff.ts";

function filesOf(patch: string) {
  return parsePatchFiles(patch).flatMap((parsed) => parsed.files);
}

describe("extractFilePatch", () => {
  it("copies one file's section of a multi-file patch", () => {
    const patch = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "diff --git a/b.ts b/b.ts",
      "--- a/b.ts",
      "+++ b/b.ts",
      "@@ -1 +1 @@",
      "-c",
      "+d",
    ].join("\n");
    const second = filesOf(patch)[1];
    expect(second && extractFilePatch(patch, second)).toBe(
      "diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-c\n+d",
    );
  });

  it("finds a file whose name git quoted and octal-escaped", () => {
    // Real `git diff` output for 한글.ts with the default core.quotePath.
    const korean = [
      String.raw`diff --git "a/\355\225\234\352\270\200.ts" "b/\355\225\234\352\270\200.ts"`,
      "index 7898192..6178079 100644",
      String.raw`--- "a/\355\225\234\352\270\200.ts"`,
      String.raw`+++ "b/\355\225\234\352\270\200.ts"`,
      "@@ -1 +1 @@",
      "-a",
      "+b",
    ].join("\n");
    const patch = `diff --git a/plain.ts b/plain.ts\n--- a/plain.ts\n+++ b/plain.ts\n@@ -1 +1 @@\n-x\n+y\n${korean}\n`;
    const file = findPatchFile(filesOf(patch), "/repo/한글.ts", "/repo");
    expect(file && resolveFileDiffPath(file)).toBe("한글.ts");
    expect(file && extractFilePatch(patch, file)).toBe(korean);
  });

  it("matches an edit's own patch, which names files by their absolute host path", () => {
    const patch = [
      "diff --git a//repo/src/a.ts b//repo/src/a.ts",
      "--- a//repo/src/a.ts",
      "+++ b//repo/src/a.ts",
      "@@ -10,2 +10,2 @@",
      " x",
      "-a",
      "+b",
      "",
    ].join("\n");
    const file = findPatchFile(filesOf(patch), "/repo/src/a.ts", "/repo");
    expect(file && resolveFileDiffPath(file)).toBe("/repo/src/a.ts");
    expect(file?.hunks[0]?.additionStart).toBe(10);
    expect(file && extractFilePatch(patch, file)).toBe(patch.trimEnd());
  });

  it("keeps a hunk's trailing blank context line", () => {
    const patch = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n-a\n+b\n \n";
    const [file] = filesOf(patch);
    expect(file && extractFilePatch(patch, file)).toBe(patch.slice(0, -1));
  });

  it("keeps the old name of a moved file with a quoted name", () => {
    const patch =
      'diff --git "a//repo/a\\tb.ts" b//repo/c.ts\nsimilarity index 100%\nrename from "/repo/a\\tb.ts"\nrename to /repo/c.ts\n';
    const file = findPatchFile(filesOf(patch), "/repo/a\tb.ts", "/repo");
    expect(file && resolveFileDiffPath(file)).toBe("/repo/c.ts");
    expect(file && resolveFileDiffPreviousPath(file)).toBe("/repo/a\tb.ts");
  });
});

describe("inlineDiffLineCount", () => {
  it("counts a small edit deep in a file by its own rows", () => {
    const patch =
      "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -450,3 +450,3 @@\n x\n-a\n+b\n y\n";
    const [file] = filesOf(patch);
    expect(file && inlineDiffLineCount(file)).toBe(4);
    expect(file?.unifiedLineCount).toBeGreaterThan(400);
  });
});
