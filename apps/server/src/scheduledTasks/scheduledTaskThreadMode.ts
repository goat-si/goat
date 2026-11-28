import {
  scheduledTaskThreadMode,
  type ScheduledTask,
  type ScheduledTaskUpsertInput,
  type ScheduledTaskThreadMode,
} from "@goat/contracts";

/**
 * Clients that predate thread modes send none, and may send a thread loaded before the first run
 * bound one. An edit keeps the stored mode; binding a thread to a new-thread task continues it.
 */
export function resolveThreadMode(
  input: Pick<ScheduledTaskUpsertInput, "threadId" | "threadMode">,
  existing: Pick<ScheduledTask, "threadId" | "threadMode"> | null,
): ScheduledTaskThreadMode {
  if (input.threadMode !== undefined) return input.threadMode;
  const stored = existing === null ? "new_thread" : scheduledTaskThreadMode(existing);
  return stored === "new_thread" && input.threadId != null ? "continue" : stored;
}
