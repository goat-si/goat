import type { PullRequestSubject } from "./pullRequestReads.graphql.ts";
import * as Effect from "effect/Effect";
import { GitHubSubjectScopeError, type GitHubPullRequestApiError } from "./GitHubPullRequestApi.ts";

type Target = {
  readonly cwd: string;
  readonly repository: string;
  readonly host: string;
  readonly number: number;
  readonly threadId: string;
  readonly operation: string;
};
export const requireThreadOfPullRequest = (
  check: (
    input: Target & { readonly subjectId: string },
  ) => Effect.Effect<boolean, GitHubPullRequestApiError>,
  input: Target,
) =>
  check({ ...input, subjectId: input.threadId }).pipe(
    Effect.flatMap((belongs) =>
      belongs
        ? Effect.void
        : Effect.fail(new GitHubSubjectScopeError({ cwd: input.cwd, operation: input.operation })),
    ),
  );

export function isSubjectOfPullRequest(result: PullRequestSubject.Result): boolean {
  const expected = result.repository?.pullRequest?.id ?? null;
  const node = result.node;
  const actual =
    node === null
      ? null
      : node.__typename === "IssueComment"
        ? (node.pullRequest?.id ?? null)
        : node.__typename === "PullRequestReviewComment"
          ? node.reviewCommentPullRequest.id
          : node.__typename === "PullRequestReview"
            ? node.reviewPullRequest.id
            : node.__typename === "PullRequestReviewThread"
              ? node.threadPullRequest.id
              : node.id;
  return expected !== null && actual !== null && expected === actual;
}
