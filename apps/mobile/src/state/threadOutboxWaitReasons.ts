import type { MessageId } from "@goat/contracts";
import { useAtomValue } from "@effect/atom-react";
import type { AtomCommandResult } from "@goat/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";

import { appAtomRegistry } from "./atom-registry";
import { shouldRetryThreadOutboxDelivery } from "./thread-outbox-model";

/**
 * Why a queued message is still waiting, when the server answered with a reason (a mode change
 * refused while a turn runs). Its row shows it until the message goes out.
 */
export const queuedMessageWaitReasonsAtom = Atom.make<Readonly<Partial<Record<MessageId, string>>>>(
  {},
).pipe(Atom.keepAlive, Atom.withLabel("mobile:thread-outbox:wait-reasons"));

export function setQueuedMessageWaitReason(messageId: MessageId, reason: string | null): void {
  const current = appAtomRegistry.get(queuedMessageWaitReasonsAtom);
  if ((current[messageId] ?? null) === reason) return;
  const { [messageId]: _previous, ...others } = current;
  appAtomRegistry.set(
    queuedMessageWaitReasonsAtom,
    reason === null ? others : { ...others, [messageId]: reason },
  );
}

export function useQueuedMessageWaitReason(messageId: MessageId | undefined): string | undefined {
  const reasons = useAtomValue(queuedMessageWaitReasonsAtom);
  return messageId === undefined ? undefined : reasons[messageId];
}

/** The server's reason for refusing a settings step, or null when the answer never arrived. */
export function settingsRefusalReason(result: AtomCommandResult<unknown, unknown>): string | null {
  if (!AsyncResult.isFailure(result) || Cause.hasInterruptsOnly(result.cause)) return null;
  const error = Cause.squash(result.cause);
  if (shouldRetryThreadOutboxDelivery(error)) return null;
  return error instanceof Error && error.message.length > 0 ? error.message : null;
}
