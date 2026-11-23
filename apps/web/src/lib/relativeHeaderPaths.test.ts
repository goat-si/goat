import { describe, expect, it } from "vitest";
import { relativeHeaderPaths } from "./relativeHeaderPaths";

describe("relativeHeaderPaths", () => {
  it("normalizes workspace paths in patch headers without changing hunks or outside paths", () => {
    const patch =
      "diff --git a//repo/a b//repo/a\n--- /repo/a\n+++ /repo/a\n@@ -1 +1 @@\n-- /repo/a\n++ /repo/b\ndiff --git a//other/b b//other/b\n--- /other/b\n+++ /other/b\n";
    expect(relativeHeaderPaths(patch, "/repo/")).toBe(
      "diff --git a/a b/a\n--- a\n+++ a\n@@ -1 +1 @@\n-- /repo/a\n++ /repo/b\ndiff --git a//other/b b//other/b\n--- /other/b\n+++ /other/b\n",
    );
  });
  it("handles escaped Windows paths case insensitively", () => {
    expect(relativeHeaderPaths('--- "C:\\\\repo\\\\a"\n+++ "C:\\\\repo\\\\a"\n', "c:\\repo")).toBe(
      '--- "a"\n+++ "a"\n',
    );
  });
});
