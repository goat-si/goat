import * as Schema from "effect/Schema";

export class GitHubBranchDeletionRefusedError extends Schema.TaggedError<GitHubBranchDeletionRefusedError>()(
  "GitHubBranchDeletionRefusedError",
  {
    number: Schema.Int,
    reason: Schema.Literals([
      "open-pr",
      "stack",
      "source-unavailable",
      "unsafe-branch",
      "head-changed",
    ]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "open-pr":
        return `Close or merge pull request #${this.number} before deleting its source branch.`;
      case "stack":
        return "Branch deletion is not supported for a stack.";
      case "source-unavailable":
        return `GitHub did not report a complete source branch for pull request #${this.number}.`;
      case "unsafe-branch":
        return "The source branch is a default or base branch and cannot be deleted here.";
      case "head-changed":
        return "The source branch has new commits and was not deleted.";
    }
  }
}

export class GitHubMergeHeadChangedError extends Schema.TaggedError<GitHubMergeHeadChangedError>()(
  "GitHubMergeHeadChangedError",
  { number: Schema.Int },
) {
  override get message(): string {
    return `The reviewed head of pull request #${this.number} differs from the merge message head.`;
  }
}

export class GitHubMergeHeadUnsupportedError extends Schema.TaggedError<GitHubMergeHeadUnsupportedError>()(
  "GitHubMergeHeadUnsupportedError",
  {},
) {
  override get message(): string {
    return "An expected head is supported only for a single pull request merge.";
  }
}
