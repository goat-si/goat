import type { PullRequestReviewCommentDraft, PullRequestReviewPosition } from "@goat/contracts";
import { quoteGitPatchPath } from "@goat/shared/gitPatchPath";
import * as Effect from "effect/Effect";

import { gitLabReviewPositionLines } from "./gitLabInput.ts";

function gitLabDiffHeader(oldPath: string, newPath: string): string {
  return `diff --git ${quoteGitPatchPath(`a/${oldPath}`)} ${quoteGitPatchPath(`b/${newPath}`)}\n`;
}

/**
 * The old and new line counters GitLab's diff parser holds at a changed line. An added line
 * keeps the old counter where it stands, and a removed line the new one, so neither side of a
 * changed line's `line_code` is known without walking its hunk.
 */
function gitLabLineCounters(
  patch: string,
  header: string,
  position: PullRequestReviewPosition,
): { readonly old: number; readonly new: number } | undefined {
  if (position.kind === "context") return { old: position.oldLine, new: position.newLine };
  const start = `\n${patch}`.indexOf(`\n${header}`);
  if (start === -1) return undefined;
  const end = patch.indexOf("\ndiff --git ", start + header.length - 1);
  const section = patch.slice(start, end === -1 ? undefined : end);
  const firstHunk = section.indexOf("\n@@ ");
  if (firstHunk === -1) return undefined;
  let oldLine = 0;
  let newLine = 0;
  for (const line of section.slice(firstHunk + 1).split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
    } else if (line.startsWith("+")) {
      if (position.kind === "added" && newLine === position.newLine) {
        return { old: oldLine, new: newLine };
      }
      newLine += 1;
    } else if (line.startsWith("-")) {
      if (position.kind === "deleted" && oldLine === position.oldLine) {
        return { old: oldLine, new: newLine };
      }
      oldLine += 1;
    } else if (line.startsWith(" ")) {
      oldLine += 1;
      newLine += 1;
    }
  }
  return undefined;
}

/**
 * One end of a ranged comment. GitLab labels the range from `old_line`/`new_line` and `type`,
 * the way its own UI sends them (`type` is null on a context line), and finds the lines to
 * highlight by `line_code`, which needs both counters from the diff.
 */
function gitLabLineRangeEnd(
  fileHash: string,
  position: PullRequestReviewPosition,
  counters: { readonly old: number; readonly new: number } | undefined,
) {
  const lines = gitLabReviewPositionLines(position);
  const oldLine = counters?.old ?? ("old_line" in lines ? lines.old_line : 0);
  const newLine = counters?.new ?? ("new_line" in lines ? lines.new_line : 0);
  return {
    line_code: `${fileHash}_${oldLine}_${newLine}`,
    type: position.kind === "added" ? "new" : position.kind === "deleted" ? "old" : null,
    ...lines,
  };
}

// GitLab's line_code hashes the file path with SHA-1; Web Crypto is available in Node.
const sha1Hex = (text: string) =>
  Effect.promise(() => crypto.subtle.digest("SHA-1", new TextEncoder().encode(text))).pipe(
    Effect.map((digest) =>
      Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
    ),
  );

export const gitLabLineRange = Effect.fn("GitLabPullRequestCli.lineRange")(function* (
  patch: string,
  comment: PullRequestReviewCommentDraft,
) {
  const start = comment.startPosition;
  if (start === undefined) return {};
  const fileHash = yield* sha1Hex(comment.path);
  const header = gitLabDiffHeader(comment.oldPath ?? comment.path, comment.path);
  const first = gitLabLineRangeEnd(fileHash, start, gitLabLineCounters(patch, header, start));
  const last = gitLabLineRangeEnd(
    fileHash,
    comment.position,
    gitLabLineCounters(patch, header, comment.position),
  );
  return first.line_code === last.line_code ? {} : { line_range: { start: first, end: last } };
});

/** Diff headers of the files whose ranged comments need line counters from the diff. */
export function gitLabRangedFileHeaders(
  comments: ReadonlyArray<PullRequestReviewCommentDraft>,
): ReadonlyArray<string> {
  return comments.flatMap((comment) =>
    comment.startPosition !== undefined &&
    (comment.startPosition.kind !== "context" || comment.position.kind !== "context")
      ? [gitLabDiffHeader(comment.oldPath ?? comment.path, comment.path)]
      : [],
  );
}

/** Reads diff pages only until every header is found, for the files ranged comments sit on. */
export const gitLabPatchCovering = <E>(
  readPage: (
    page: number,
  ) => Effect.Effect<{ readonly patch: string; readonly nextCursor: string | null }, E>,
  headers: ReadonlyArray<string>,
  page = 1,
  collected = "",
): Effect.Effect<string, E> =>
  headers.every((header) => `\n${collected}`.includes(`\n${header}`))
    ? Effect.succeed(collected)
    : readPage(page).pipe(
        Effect.flatMap((slice) =>
          slice.nextCursor === null
            ? Effect.succeed(collected + slice.patch)
            : gitLabPatchCovering(readPage, headers, page + 1, collected + slice.patch),
        ),
      );
