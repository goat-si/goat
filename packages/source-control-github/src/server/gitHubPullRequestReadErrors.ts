import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

export class GitHubPullRequestReadError extends Schema.TaggedError<GitHubPullRequestReadError>()(
  "GitHubPullRequestReadError",
  {
    cwd: Schema.String,
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `GitHub returned an unreadable ${this.operation} response.`;
  }
}

export class GitHubDiffCursorError extends Schema.TaggedError<GitHubDiffCursorError>()(
  "GitHubDiffCursorError",
  {
    cwd: Schema.String,
  },
) {
  override get message(): string {
    return "The diff cursor was not one this pull request handed out.";
  }
}

export class GitHubDiffCommitError extends Schema.TaggedError<GitHubDiffCommitError>()(
  "GitHubDiffCommitError",
  {
    cwd: Schema.String,
  },
) {
  override get message(): string {
    return "The named commit was not a commit sha.";
  }
}

export const readError = (cwd: string, operation: string, cause: unknown) =>
  new GitHubPullRequestReadError({ cwd, operation, cause });

export const decodeWith = <A>(
  cwd: string,
  operation: string,
  decode: (raw: string) => Result.Result<A, unknown>,
  raw: string,
): Effect.Effect<A, GitHubPullRequestReadError> => {
  const decoded = decode(raw.trim());
  return Result.isSuccess(decoded)
    ? Effect.succeed(decoded.success)
    : Effect.fail(readError(cwd, operation, decoded.failure));
};
