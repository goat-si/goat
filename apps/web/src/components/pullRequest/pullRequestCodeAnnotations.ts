import type { PullRequestDiffSide, PullRequestReviewThread } from "@goat/contracts";
import type { DiffLineAnnotation } from "@pierre/diffs";
import type { PendingReviewComment } from "./pullRequestReviewStore";
import type { PullRequestImagePreview } from "./PullRequestImageAnnotation";

export interface ReviewAnnotationGroup {
  readonly threads: ReadonlyArray<PullRequestReviewThread>;
  readonly pending: ReadonlyArray<PendingReviewComment>;
  readonly draft: boolean;
  readonly image?: PullRequestImagePreview;
  readonly withheld?: {
    readonly path: string;
    readonly status: "idle" | "loading" | "error" | "empty";
    readonly readable: boolean;
  };
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
