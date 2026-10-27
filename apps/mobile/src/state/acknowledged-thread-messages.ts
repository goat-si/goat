import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import { appAtomRegistry } from "./atom-registry";
import type { QueuedThreadMessage } from "./thread-outbox-model";
import { environmentThreadDetails } from "./threads";

// Keep acknowledged rows until their subscribed projection arrives; command receipts can precede messages.
export const acknowledgedThreadMessagesAtom = Atom.make<ReadonlyArray<QueuedThreadMessage>>(
  [],
).pipe(Atom.keepAlive);

function isEchoedInMountedThread(message: QueuedThreadMessage): boolean {
  const threadAtom = environmentThreadDetails.threadAtom({
    environmentId: message.environmentId,
    threadId: message.threadId,
  });
  // Reading through the registry would start a snapshot load and live stream for an unmounted thread.
  const node = appAtomRegistry.getNodes().get(threadAtom);
  if (node === undefined) return false;
  const loaded: Option.Option<Atom.Type<typeof threadAtom>> = node.valueOption();
  const thread = Option.getOrNull(loaded);
  return thread?.projection.messages.some((entry) => entry.id === message.messageId) ?? false;
}

function writeAcknowledgedThreadMessages(
  update: (current: ReadonlyArray<QueuedThreadMessage>) => ReadonlyArray<QueuedThreadMessage>,
) {
  const current = appAtomRegistry.get(acknowledgedThreadMessagesAtom);
  const next = update(current).filter((entry) => !isEchoedInMountedThread(entry));
  if (next.length === current.length && next.every((entry, index) => entry === current[index])) {
    return;
  }
  appAtomRegistry.set(acknowledgedThreadMessagesAtom, next);
}

export function retainAcknowledgedThreadMessage(message: QueuedThreadMessage) {
  writeAcknowledgedThreadMessages((current) =>
    current.some((entry) => entry.messageId === message.messageId)
      ? current
      : [...current, message],
  );
}

export function forgetAcknowledgedThreadMessage(message: QueuedThreadMessage) {
  writeAcknowledgedThreadMessages((current) =>
    current.filter((entry) => entry.messageId !== message.messageId),
  );
}
