import { expect, it } from "vite-plus/test";
import { buildReviewCommentPatch } from "./reviewCommentPatch";
import { buildNativeReviewDiffData } from "./nativeReviewDiffAdapter";
import { buildReviewParsedDiff } from "./reviewModel";

it("keeps a trailing blank context line and its whitespace", () => {
  const patch = buildReviewCommentPatch({
    id: "comment-1",
    sectionId: "worktree",
    sectionTitle: "Worktree",
    filePath: "example.ts",
    startIndex: 0,
    endIndex: 0,
    rangeLabel: "1",
    text: "Review",
    diff: "\n@@ -3,1 +2,2 @@\n+two\t\n \n",
  });
  const rows = buildNativeReviewDiffData(
    buildReviewParsedDiff(patch, "trailing-context"),
  ).rows.filter((row) => row.kind === "line");
  expect(rows).toMatchObject([
    { content: "two\t", change: "add" },
    { content: "", change: "context" },
  ]);
});
