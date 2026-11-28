import * as Schema from "effect/Schema";
import { GitRefName, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { GitCommandError } from "./git.ts";
import { VcsError } from "./vcs.ts";

const ReviewMergeBase = Schema.String.check(
  Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64}|HEAD)$/),
);

export const ReviewDiffPreviewSourceKind = Schema.Literals([
  "working-tree",
  "branch-range",
  "staged",
  "unstaged",
]);
export type ReviewDiffPreviewSourceKind = typeof ReviewDiffPreviewSourceKind.Type;

export const ReviewDiffPreviewInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  /** Read only this comparison. Omitted for legacy clients requesting both original views. */
  scope: Schema.optionalKey(ReviewDiffPreviewSourceKind),
  baseRef: Schema.optional(GitRefName),
  mergeBase: Schema.optionalKey(ReviewMergeBase),
  ignoreWhitespace: Schema.optionalKey(Schema.Boolean),
  metadataOnly: Schema.optionalKey(Schema.Boolean),
  trackedOnly: Schema.optionalKey(Schema.Boolean),
  file: Schema.optionalKey(
    Schema.Struct({
      path: Schema.NonEmptyString,
      previousPath: Schema.NullOr(Schema.NonEmptyString),
      changeType: Schema.optionalKey(Schema.String),
      sourceKind: ReviewDiffPreviewSourceKind,
    }),
  ),
});
export type ReviewDiffPreviewInput = typeof ReviewDiffPreviewInput.Type;

export const ReviewDiffFileStat = Schema.Struct({
  path: Schema.String,
  previousPath: Schema.NullOr(Schema.String),
  changeType: Schema.optionalKey(Schema.String),
  additions: Schema.Number,
  deletions: Schema.Number,
});
export type ReviewDiffFileStat = typeof ReviewDiffFileStat.Type;

export function reviewFileChangeType(
  stat: Pick<ReviewDiffFileStat, "changeType" | "previousPath">,
) {
  switch (stat.changeType) {
    case undefined:
      return stat.previousPath ? "rename-changed" : "change";
    case "change":
    case "rename-pure":
    case "rename-changed":
    case "new":
    case "deleted":
      return stat.changeType;
    default:
      return "unknown";
  }
}

export const ReviewDiffPreviewSource = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: ReviewDiffPreviewSourceKind,
  title: TrimmedNonEmptyString,
  baseRef: Schema.NullOr(GitRefName),
  headRef: Schema.NullOr(GitRefName),
  mergeBase: Schema.optionalKey(ReviewMergeBase),
  diff: Schema.String,
  diffHash: TrimmedNonEmptyString,
  truncated: Schema.Boolean,
  patchesDeferred: Schema.optionalKey(Schema.Boolean),
  files: Schema.optionalKey(Schema.Array(ReviewDiffFileStat)),
});
export type ReviewDiffPreviewSource = typeof ReviewDiffPreviewSource.Type;

export const ReviewDiffFileContentsInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  sourceKind: ReviewDiffPreviewSourceKind,
  changeType: Schema.Literals(["change", "rename-pure", "rename-changed", "new", "deleted"]),
  baseRef: Schema.NullOr(GitRefName),
  headRef: Schema.NullOr(GitRefName),
  oldPath: TrimmedNonEmptyString,
  newPath: TrimmedNonEmptyString,
});
export type ReviewDiffFileContentsInput = typeof ReviewDiffFileContentsInput.Type;

export const ReviewDiffFileContentsResult = Schema.Struct({
  oldContents: Schema.String,
  newContents: Schema.String,
});
export type ReviewDiffFileContentsResult = typeof ReviewDiffFileContentsResult.Type;

export const ReviewDiffPreviewResult = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  generatedAt: Schema.DateTimeUtc,
  sources: Schema.Array(ReviewDiffPreviewSource),
  incomplete: Schema.optionalKey(Schema.Boolean),
});
export type ReviewDiffPreviewResult = typeof ReviewDiffPreviewResult.Type;

export const ReviewDiffPreviewError = Schema.Union([VcsError, GitCommandError]);
export type ReviewDiffPreviewError = typeof ReviewDiffPreviewError.Type;
