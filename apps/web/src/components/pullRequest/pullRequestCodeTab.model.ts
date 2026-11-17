import type { DiffLineAnnotation, SelectedLineRange } from "@pierre/diffs";
import type {
  PullRequestDiffSide,
  PullRequestReviewPosition,
  PullRequestReviewThread,
} from "@goat/contracts";

import type { PullRequestImagePreview } from "./PullRequestImageAnnotation";
import type { PendingReviewComment } from "./pullRequestReviewStore";

export interface ReviewAnnotationGroup {
  readonly threads: ReadonlyArray<PullRequestReviewThread>;
  readonly pending: ReadonlyArray<PendingReviewComment>;
  readonly draft: boolean;
  readonly image?: PullRequestImagePreview;
}

export type ReviewAnnotation = DiffLineAnnotation<ReviewAnnotationGroup>;

export const COMMIT_PAGE_SIZE = 10;

export const PULL_REQUEST_FILE_TREE_STORAGE_KEY = "goat.pullRequestFileTreeOpen";

// Show host counts outside the shadow root; hunk totals are zero when hosts withhold hunks.
export const REPLACE_FILE_COUNTS_CSS = `
[data-diffs-header] [data-additions-count],
[data-diffs-header] [data-deletions-count] {
  display: none !important;
}`;

export interface MutableAnnotationGroup {
  readonly side: PullRequestDiffSide;
  readonly line: number;
  readonly threads: PullRequestReviewThread[];
  readonly pending: PendingReviewComment[];
  draft: boolean;
}

export interface DraftAnchor {
  readonly fileKey: string;
  readonly path: string;
  readonly oldPath: string | null;
  readonly position: PullRequestReviewPosition;
  readonly startPosition?: PullRequestReviewPosition;
  readonly range: SelectedLineRange;
}
