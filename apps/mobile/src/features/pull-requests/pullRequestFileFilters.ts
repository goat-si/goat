import { classifyChangedFile } from "@goat/shared/changedFileKind";
import type { ReviewParsedDiff } from "../review/reviewModel";

/** Test support such as fixtures and snapshots is hidden along with the tests. */
export function isPullRequestTestFile(path: string): boolean {
  const kind = classifyChangedFile(path);
  return kind === "tests" || kind === "mocks";
}

export function filterPullRequestTestFiles(
  parsed: ReviewParsedDiff,
  hideTestFiles: boolean,
  includePath?: string,
): ReviewParsedDiff {
  if (!hideTestFiles || parsed.kind !== "files") return parsed;
  const files = parsed.files.filter(
    (file) => file.path === includePath || !isPullRequestTestFile(file.path),
  );
  if (files.length === parsed.files.length) return parsed;
  return {
    ...parsed,
    files,
    fileCount: files.length,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
  };
}

/** Patches to load around `index` (or from the top): the next three files the review will show. */
export function shownPatchIndices(
  files: ReadonlyArray<{ readonly path: string }>,
  hideTestFiles: boolean,
  index: number | null,
): ReadonlyArray<number> {
  const shown = files.flatMap((file, position) =>
    hideTestFiles && isPullRequestTestFile(file.path) ? [] : [position],
  );
  if (index === null) return shown.slice(0, 3);
  const position = shown.indexOf(index);
  return position < 0 ? [index] : shown.slice(position, position + 3);
}
