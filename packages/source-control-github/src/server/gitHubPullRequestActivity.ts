import type { PullRequestActor, PullRequestComment, PullRequestCommit } from "@goat/contracts";

export interface GitHubPullRequestActivity {
  readonly author: PullRequestActor | null;
  readonly comments: ReadonlyArray<PullRequestComment>;
  readonly commits: ReadonlyArray<PullRequestCommit>;
}
