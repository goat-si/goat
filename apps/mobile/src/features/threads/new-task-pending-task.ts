import { appAtomRegistry } from "../../state/atom-registry";
import {
  flattenQueuedThreadMessages,
  threadOutboxManager,
  type QueuedThreadMessage,
} from "../../state/thread-outbox";

export function pendingTaskDraftKey(messageId: string): string {
  return `pending-task:${messageId}`;
}

export function findQueuedPendingTask(messageId: string): QueuedThreadMessage | null {
  const message = flattenQueuedThreadMessages(
    appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom),
  ).find((candidate) => candidate.messageId === messageId);
  return message?.creation !== undefined ? message : null;
}
