import * as Schema from "effect/Schema";

export class GitLabPinnedAutoMergeError extends Schema.TaggedError<GitLabPinnedAutoMergeError>()(
  "GitLabPinnedAutoMergeError",
  {},
) {
  get detail(): string {
    return "A pinned head cannot be guaranteed for an automatic merge. Merge directly or omit headSha.";
  }
  override get message(): string {
    return this.detail;
  }
}

export class GitLabDiffRefsUnavailableError extends Schema.TaggedError<GitLabDiffRefsUnavailableError>()(
  "GitLabDiffRefsUnavailableError",
  {
    command: Schema.Literal("glab"),
    cwd: Schema.String,
    number: Schema.Int,
  },
) {
  get detail(): string {
    return "The merge request reported no diff revisions.";
  }

  override get message(): string {
    return `GitLab CLI failed in getDiffRefs: ${this.detail}`;
  }
}

export class GitLabPinnedRebaseError extends Schema.TaggedError<GitLabPinnedRebaseError>()(
  "GitLabPinnedRebaseError",
  { number: Schema.Int },
) {
  get detail(): string {
    return `GitLab cannot enforce the reviewed head for this action on pull request #${this.number}.`;
  }

  override get message(): string {
    return this.detail;
  }
}
