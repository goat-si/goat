import type { ReviewInlineComment } from "./reviewCommentSelection";

export function reviewCommentDiffText(diff: string): string {
  return diff.replace(/^\n+|\n+$/g, "");
}

export function buildReviewCommentPatch(comment: ReviewInlineComment): string {
  if ((comment.fenceLanguage ?? "diff") !== "diff") {
    return "";
  }
  if (!comment.diff.trim()) {
    return "";
  }

  const diff = reviewCommentDiffText(comment.diff);
  if (diff.startsWith("diff --git ")) {
    return diff;
  }

  const normalizedPath = comment.filePath.replaceAll("\\", "/");
  return [
    `diff --git a/${normalizedPath} b/${normalizedPath}`,
    `--- a/${normalizedPath}`,
    `+++ b/${normalizedPath}`,
    diff,
  ].join("\n");
}
