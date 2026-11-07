import * as Schema from "effect/Schema";

export class WorkspaceLeaseBusyError extends Schema.TaggedError<WorkspaceLeaseBusyError>()(
  "WorkspaceLeaseBusyError",
  {},
) {
  override get message(): string {
    return "Workspace is busy with checkout removal or preparation.";
  }
}
