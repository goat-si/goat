import { ThreadId, type ScheduledTask } from "@goat/contracts";
import * as Effect from "effect/Effect";
import { taskError } from "./scheduledTaskError.ts";
import type { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";

export const hasQueuedOccurrence = Effect.fn("ScheduledTaskService.hasQueuedOccurrence")(function* (
  threads: ThreadManagementService["Service"],
  task: ScheduledTask,
  trigger: "scheduled" | "manual" | "webhook",
) {
  if (trigger !== "scheduled" || task.threadId === null) return false;
  const threadId = ThreadId.make(task.threadId);
  const { runs } = yield* threads
    .getThreadRecords(threadId, ["runs"])
    .pipe(
      Effect.mapError((cause) =>
        taskError("Could not check queued task occurrences.", { taskId: task.id, cause }),
      ),
    );
  const queued = runs.filter((run) => run.status === "queued");
  if (queued.length === 0) return false;
  const messageIds = queued.map((run) => run.userMessageId);
  const { messages } = yield* threads
    .getThreadRecords(threadId, ["messages"], { messageIds })
    .pipe(
      Effect.mapError((cause) =>
        taskError("Could not check queued task occurrences.", { taskId: task.id, cause }),
      ),
    );
  const queuedIds = new Set(messageIds);
  return messages.some(
    (message) => queuedIds.has(message.id) && message.scheduledTaskId === task.id,
  );
});
