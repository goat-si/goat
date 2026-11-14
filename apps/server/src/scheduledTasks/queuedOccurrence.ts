import { ThreadId, type ScheduledTask } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";

// Reads only queued runs and their messages, so a due firing does not load
// the thread's whole run history. A failed read falls through to the normal
// send, which already handles a missing thread and records the outcome.
export const hasQueuedOccurrence = Effect.fn("ScheduledTaskService.hasQueuedOccurrence")(function* (
  threads: ThreadManagementService["Service"],
  task: ScheduledTask,
  trigger: "scheduled" | "manual" | "webhook",
) {
  if (trigger !== "scheduled" || task.threadId === null) return false;
  const threadId = ThreadId.make(task.threadId);
  return yield* Effect.gen(function* () {
    const { runs } = yield* threads.getThreadRecords(threadId, ["runs"], {
      runStatuses: ["queued"],
    });
    if (runs.length === 0) return false;
    const messageIds = runs.map((run) => run.userMessageId);
    const { messages } = yield* threads.getThreadRecords(threadId, ["messages"], { messageIds });
    const queuedIds = new Set(messageIds);
    return messages.some(
      (message) => queuedIds.has(message.id) && message.scheduledTaskId === task.id,
    );
  }).pipe(Effect.orElseSucceed(() => false));
});
