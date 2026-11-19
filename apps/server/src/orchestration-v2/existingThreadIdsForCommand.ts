import type { OrchestrationV2ServerCommand, ThreadId } from "@goat/contracts";

export function existingThreadIdsForCommand(
  command: OrchestrationV2ServerCommand,
): ReadonlyArray<ThreadId> {
  switch (command.type) {
    case "thread.create":
      return [];
    // Read-state commands only rewrite the thread payload's visited/unread
    // watermark and open stats; they never touch messages, so they do not need the imported
    // v1 transcript hydrated first. Visits fire on every thread-activity bump
    // while a thread is open, so keeping them off the import path matters.
    case "thread.visit":
    case "thread.mark-unread":
      return [];
    case "thread.fork":
      return [command.sourceThreadId];
    case "thread.merge_back":
      return command.sourceThreadId === command.targetThreadId
        ? [command.sourceThreadId]
        : [command.sourceThreadId, command.targetThreadId];
    case "delegated_task.request":
    case "delegated_task.remote.register":
    case "delegated_task.remote.progress":
    case "delegated_task.remote.result":
    case "delegated_task.wake-policy":
    case "delegated_task.review-ledger.append":
    case "delegated_task.completion-delivery.acknowledge":
    case "delegated_task.completion-delivery.dispose":
      return [command.parentThreadId];
    case "thread.created.record":
      return command.parentThreadId === command.targetThreadId
        ? [command.parentThreadId]
        : [command.parentThreadId, command.targetThreadId];
    case "thread.notice.record":
      return [command.threadId];
    default:
      return [command.threadId];
  }
}
