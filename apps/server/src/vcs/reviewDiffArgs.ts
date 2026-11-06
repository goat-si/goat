import type { ReviewDiffFileStat } from "@goat/contracts";

// Client patch parsers require a/ and b/ prefixes; override user diff prefix settings.
export const PATCH_RENDER_PREFIX_ARGS = ["--src-prefix=a/", "--dst-prefix=b/"] as const;
// Client patch parsers drop blank context lines under diff.suppressBlankEmpty and summaries under diff.submodule.
export const REVIEW_DIFF_ARGS = [
  "-c",
  "diff.suppressBlankEmpty=false",
  "diff",
  "--find-renames",
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--submodule=short",
  ...PATCH_RENDER_PREFIX_ARGS,
];

export const REVIEW_DIFF_PATCH_MAX_OUTPUT_BYTES = 120_000;
export const REVIEW_METADATA_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
// Temporary-index git add scales poorly (50k files took ~30 s); report incomplete totals above this cap.
export const REVIEW_UNTRACKED_MAX_FILES = 5_000;
export const REVIEW_DIFF_FILE_MAX_OUTPUT_BYTES = 1024 * 1024;

export function parseReviewNumstat(stdout: string): ReviewDiffFileStat[] {
  const fields = stdout.split("\0");
  const files: ReviewDiffFileStat[] = [];
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index] ?? "";
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(field);
    if (!match) continue;
    const previousPath = match[3] === "" ? fields[++index] : null;
    const path = previousPath !== null ? fields[++index] : match[3];
    if (previousPath === undefined || path === undefined) continue;
    files.push({
      path,
      previousPath,
      additions: match[1] === "-" ? 0 : Number(match[1]),
      deletions: match[2] === "-" ? 0 : Number(match[2]),
    });
  }
  return files;
}
