import type { MessageId } from "@goat/contracts";

// A palette message result opens its thread at that message. The thread
// screen reads the request while it shows that thread, and finishes it once
// the feed is there or the message cannot be found. A request whose thread
// never showed lapses, so a later plain open does not jump, as on web.
const PENDING_JUMP_MS = 30_000;
let requests = 0;
let pending: {
  readonly id: number;
  readonly threadKey: string;
  readonly messageId: MessageId;
  readonly at: number;
} | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

export function requestThreadMessageJump(threadKey: string, messageId: MessageId): void {
  pending = { id: ++requests, threadKey, messageId, at: Date.now() };
  notify();
}

function pendingFor(threadKey: string) {
  return pending?.threadKey === threadKey && Date.now() - pending.at < PENDING_JUMP_MS
    ? pending
    : null;
}

/** The message this thread should open at, if a palette pick asked for one. */
export function pendingThreadMessageJump(threadKey: string): MessageId | null {
  return pendingFor(threadKey)?.messageId ?? null;
}

/** Which pick that is: the same message can be picked again while its first jump loads. */
export function pendingThreadMessageJumpId(threadKey: string): number | null {
  return pendingFor(threadKey)?.id ?? null;
}

/** Ends the thread's jump, or only the pick with this id when one is given. */
export function finishThreadMessageJump(threadKey: string, id?: number): void {
  if (pending?.threadKey !== threadKey || (id !== undefined && pending.id !== id)) return;
  pending = null;
  notify();
}

export function subscribeThreadMessageJump(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
