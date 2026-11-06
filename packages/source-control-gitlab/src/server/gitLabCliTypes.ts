import type { PullRequestReviewThread } from "@goat/contracts";
import type {
  GitLabDiffRefs,
  GitLabMergeRequestListItem,
  GitLabMergeRequestListState,
} from "./gitLabMergeRequestJson.ts";

export interface GitLabDiscussionThreads {
  readonly threads: ReadonlyArray<PullRequestReviewThread>;
  readonly diffRefsByThreadId: ReadonlyMap<string, GitLabDiffRefs>;
  readonly overviewFindingIds: ReadonlyArray<string>;
  readonly truncated: boolean;
}

export interface GitLabMergeRequestListBatch {
  readonly items: ReadonlyArray<GitLabMergeRequestListItem>;
  readonly truncated: boolean;
  readonly cursorAdvance: number;
  /** GitLab's GraphQL cursor past the last row, when the page was read through GraphQL. */
  readonly resumeAfter?: string;
  /** Present when the read already carried each row's approval and pipeline state. */
  readonly listStates?: ReadonlyMap<number, GitLabMergeRequestListState>;
}

export interface GitLabMergeRequestDiffSlice {
  readonly patch: string;
  readonly truncated: boolean;
  readonly nextCursor: string | null;
}
