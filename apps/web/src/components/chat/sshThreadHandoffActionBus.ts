import type { ScopedThreadRef } from "@goat/contracts";

const SSH_THREAD_HANDOFF_EVENT = "goat:ssh-thread-handoff";

/** Header and palette target the mounted chat by full environment/thread identity. */
export function requestSshThreadHandoff(threadRef: ScopedThreadRef): void {
  window.dispatchEvent(new CustomEvent(SSH_THREAD_HANDOFF_EVENT, { detail: threadRef }));
}

export function subscribeSshThreadHandoff(
  listener: (threadRef: ScopedThreadRef) => void,
): () => void {
  const handler = (event: Event) => listener((event as CustomEvent<ScopedThreadRef>).detail);
  window.addEventListener(SSH_THREAD_HANDOFF_EVENT, handler);
  return () => window.removeEventListener(SSH_THREAD_HANDOFF_EVENT, handler);
}
