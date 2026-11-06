import * as Schema from "effect/Schema";

export class GitLabBranchDeletionRefusedError extends Schema.TaggedError<GitLabBranchDeletionRefusedError>()(
  "GitLabBranchDeletionRefusedError",
  {
    command: Schema.Literal("glab"),
    cwd: Schema.String,
    number: Schema.Int,
    reason: Schema.Literals([
      "open",
      "not-allowed",
      "source-unavailable",
      "default-branch",
      "head-changed",
    ]),
  },
) {
  get detail(): string {
    switch (this.reason) {
      case "open":
        return `Close or merge merge request !${this.number} before deleting its source branch.`;
      case "not-allowed":
        return "GitLab does not let you delete this source branch. It may be protected, or you may not be able to push to it.";
      case "source-unavailable":
        return `GitLab did not report a source project for merge request !${this.number}.`;
      case "default-branch":
        return "The source branch is its project's default branch and cannot be deleted here.";
      case "head-changed":
        return "The source branch has new commits and was not deleted.";
    }
  }

  override get message(): string {
    return `GitLab CLI failed in deleteSourceBranch: ${this.detail}`;
  }
}
