import * as Data from "effect/Data";
import * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";

export class GitHubFailure extends Data.TaggedError("GitHubFailure")<{
  readonly detail: string;
  readonly cause: unknown;
}> {}

export const failure = (detail: string, cause?: unknown) => new GitHubFailure({ detail, cause });

const PULL_REQUEST_NOT_FOUND = "Pull request not found. Check the PR number or URL and try again.";
export const REPOSITORY_NOT_FOUND = "Repository not found. Check the owner and name and try again.";

export function fromGitHubApiError(
  error: GitHubRequestPolicy.GitHubApiError,
  notFound = PULL_REQUEST_NOT_FOUND,
): GitHubFailure {
  switch (error._tag) {
    case "GitHubCliMissingError":
      return failure(
        "No GitHub credential on the server. Set GH_TOKEN, or install the GitHub CLI and run `gh auth login`.",
        error,
      );
    case "GitHubNotSignedInError":
    case "GitHubHostDisabledError":
      return failure(error.message, error);
    case "GitHubApiAuthenticationError":
      return failure(
        "GitHub is not authenticated. Run `gh auth login` (or set GH_TOKEN) and retry.",
        error,
      );
    case "GitHubApiRateLimitError":
    case "SourceControlRateLimitPausedError":
      return failure(
        "GitHub API rate limit exceeded. Requests resume when the limit resets.",
        error,
      );
    case "GitHubApiNotFoundError":
      return failure(notFound, error);
    case "GitHubCliFailedError":
    case "GitHubApiResponseError":
    case "GitHubApiRequestError":
      return failure(error.message.trim() || "GitHub request failed.", error);
  }
}

export const notFound = (cause: string) => failure(PULL_REQUEST_NOT_FOUND, new Error(cause));
