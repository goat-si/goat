import type { MessageId } from "@goat/contracts";
import { Atom } from "effect/reactivity";

export const dispatchingQueuedMessageIdsAtom = Atom.make<
  Readonly<Partial<Record<MessageId, true>>>
>({}).pipe(Atom.keepAlive);

export function selectedDispatchingMessage(
  messages: ReadonlyArray<{ readonly messageId: MessageId } | null | undefined>,
  ids: Readonly<Partial<Record<MessageId, true>>>,
  fallback: MessageId | null,
): MessageId | null {
  return messages.find((message) => message && ids[message.messageId])?.messageId ?? fallback;
}
