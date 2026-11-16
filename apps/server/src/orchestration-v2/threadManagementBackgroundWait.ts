import { ThreadId } from "@goat/contracts";
import * as Schema from "effect/Schema";

export class ThreadManagementBackgroundWaitError extends Schema.TaggedError<ThreadManagementBackgroundWaitError>()(
  "ThreadManagementBackgroundWaitError",
  {
    threadId: ThreadId,
    reason: Schema.Literals(["unsupported", "unavailable", "failed", "unmatched"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "unsupported":
        return "This provider cannot mark background work as awaited.";
      case "unavailable":
        return "This thread has no live provider session.";
      case "failed":
        return "Failed to update the awaited background work.";
      case "unmatched":
        return "None of these IDs is running background work on this thread, so this request registers no wait for them. If the task already finished, read its output now. Otherwise pass the task ID of a background command or Monitor you started. Subagent, Agent tool, and goat_task_create IDs don't go here.";
    }
  }
}
