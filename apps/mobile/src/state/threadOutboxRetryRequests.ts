import type { MessageId } from "@goat/contracts";
import { Atom } from "effect/reactivity";
import { appAtomRegistry } from "./atom-registry";

export const UPLOAD_RETRY_EXHAUSTED_REASON =
  "Attachment upload failed. Retry to send this message.";
export const queuedMessageRetryRequestAtom = Atom.make<{ readonly messageId: MessageId } | null>(
  null,
).pipe(Atom.keepAlive);

export function retryQueuedMessage(messageId: MessageId): void {
  appAtomRegistry.set(queuedMessageRetryRequestAtom, { messageId });
}
