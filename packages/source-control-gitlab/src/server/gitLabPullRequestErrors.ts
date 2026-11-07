import * as Schema from "effect/Schema";

export class GitLabMergeRequestReadError extends Schema.TaggedError<GitLabMergeRequestReadError>()(
  "GitLabMergeRequestReadError",
  {
    command: Schema.Literal("glab"),
    cwd: Schema.String,
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  get detail(): string {
    return `GitLab CLI returned an unreadable ${this.operation} response.`;
  }

  override get message(): string {
    return `GitLab CLI failed in ${this.operation}: ${this.detail}`;
  }
}

export class GitLabViewerUnavailableError extends Schema.TaggedError<GitLabViewerUnavailableError>()(
  "GitLabViewerUnavailableError",
  {
    command: Schema.Literal("glab"),
    cwd: Schema.String,
  },
) {
  get detail(): string {
    return "GitLab CLI returned no username for the authenticated account.";
  }

  override get message(): string {
    return `GitLab CLI failed in getViewerUsername: ${this.detail}`;
  }
}

export class GitLabDiffCursorError extends Schema.TaggedError<GitLabDiffCursorError>()(
  "GitLabDiffCursorError",
  {
    command: Schema.Literal("glab"),
    cwd: Schema.String,
  },
) {
  get detail(): string {
    return "The diff cursor was not one this merge request handed out.";
  }

  override get message(): string {
    return `GitLab CLI failed in getMergeRequestDiff: ${this.detail}`;
  }
}

export class GitLabDiffCommitError extends Schema.TaggedError<GitLabDiffCommitError>()(
  "GitLabDiffCommitError",
  {
    command: Schema.Literal("glab"),
    cwd: Schema.String,
  },
) {
  get detail(): string {
    return "The named commit was not a commit sha.";
  }

  override get message(): string {
    return `GitLab CLI failed in getMergeRequestDiff: ${this.detail}`;
  }
}

export class GitLabDiffCommitParentUnavailableError extends Schema.TaggedError<GitLabDiffCommitParentUnavailableError>()(
  "GitLabDiffCommitParentUnavailableError",
  {
    command: Schema.Literal("glab"),
    cwd: Schema.String,
    commit: Schema.String,
  },
) {
  get detail(): string {
    return `Commit ${this.commit} reported no parent revision.`;
  }

  override get message(): string {
    return `GitLab CLI failed in getMergeRequestDiffFileContents: ${this.detail}`;
  }
}

export class GitLabDiffFileContentsUnavailableError extends Schema.TaggedError<GitLabDiffFileContentsUnavailableError>()(
  "GitLabDiffFileContentsUnavailableError",
  {
    command: Schema.Literal("glab"),
    cwd: Schema.String,
    path: Schema.String,
    reason: Schema.Literals(["oversized", "binary"]),
  },
) {
  get detail(): string {
    return this.reason === "oversized"
      ? `The diff file '${this.path}' exceeds the 1 MB expansion limit.`
      : `The diff file '${this.path}' is binary.`;
  }

  override get message(): string {
    return `GitLab CLI failed in getMergeRequestDiffFileContents: ${this.detail}`;
  }
}

export class GitLabUnknownLabelError extends Schema.TaggedError<GitLabUnknownLabelError>()(
  "GitLabUnknownLabelError",
  {
    command: Schema.Literal("glab"),
    cwd: Schema.String,
    labels: Schema.Array(Schema.String),
  },
) {
  get detail(): string {
    return `The project has no label named ${this.labels.map((label) => `"${label}"`).join(", ")}.`;
  }

  override get message(): string {
    return `GitLab CLI failed in setLabels: ${this.detail}`;
  }
}

export class GitLabMutationRefusedError extends Schema.TaggedError<GitLabMutationRefusedError>()(
  "GitLabMutationRefusedError",
  {
    command: Schema.Literal("glab"),
    cwd: Schema.String,
    operation: Schema.String,
    reasons: Schema.Array(Schema.String),
  },
) {
  get detail(): string {
    return `GitLab refused it: ${this.reasons.join("; ")}`;
  }

  override get message(): string {
    return `GitLab CLI failed in ${this.operation}: ${this.detail}`;
  }
}
