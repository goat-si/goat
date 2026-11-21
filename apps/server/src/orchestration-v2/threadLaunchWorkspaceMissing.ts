import { ProjectId } from "@goat/contracts";
import * as Schema from "effect/Schema";

/**
 * An agent or server launch named a folder that is gone from this machine, such as a
 * project whose checkout was deleted or never cloned here. Refused before any thread exists.
 */
export class ThreadLaunchWorkspaceMissingError extends Schema.TaggedError<ThreadLaunchWorkspaceMissingError>()(
  "ThreadLaunchWorkspaceMissingError",
  {
    projectId: ProjectId,
    projectTitle: Schema.String,
    /** `project` is the project's own folder; `worktree` an existing worktree the launch named. */
    kind: Schema.Literals(["project", "worktree"]),
    path: Schema.String,
    /** The project's remote, when GOAT still knows it, so a caller can clone it back. */
    remoteUrl: Schema.NullOr(Schema.String),
  },
) {
  override get message(): string {
    return this.kind === "project"
      ? `Project "${this.projectTitle}" points at ${this.path}, which does not exist on this machine. No thread was created.`
      : `Worktree ${this.path} of project "${this.projectTitle}" does not exist on this machine. No thread was created.`;
  }
}
