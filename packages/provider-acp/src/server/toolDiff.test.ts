import { expect, it } from "vite-plus/test";
import { acpToolCallDiffPatch } from "./toolDiff.ts";

it("keeps every native and structured patch in a mixed tool call", () => {
  const result = acpToolCallDiffPatch([
    { type: "diff", patch: { text: "diff --git a/a b/a\n@@ -1 +1 @@\n-a\n+A\n" } },
    { type: "diff", patch: { text: "diff --git a/b b/b\n@@ -1 +1 @@\n-b\n+B\n" } },
    { type: "diff", path: "c", oldText: "c\n", newText: "C\n" },
  ]);
  expect(result).toContain("diff --git a/a b/a");
  expect(result).toContain("diff --git a/b b/b");
  expect(result).toContain('diff --git "a/c" "b/c"');
  expect(result).toContain("-c\n+C");
});
