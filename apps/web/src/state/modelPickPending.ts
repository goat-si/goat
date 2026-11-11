import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@goat/contracts";
import type { Atom } from "effect/reactivity";

export type PendingThreadIdsAtom = (
  environmentId: EnvironmentId,
) => Atom.Atom<ReadonlySet<ThreadId>>;
export function hasPendingThreadPick(
  get: Atom.AtomContext,
  pending: PendingThreadIdsAtom | undefined,
  ref: ScopedThreadRef,
): boolean {
  return pending !== undefined && get(pending(ref.environmentId)).has(ref.threadId);
}
