import { scopedProjectKey } from "@goat/client-runtime/environment";
import type { ScopedProjectRef } from "@goat/contracts";
import { useSyncExternalStore } from "react";

const silenced = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

/**
 * Keeps a clone's progress out of toasts once the user is looking at its
 * project, whose composer shows the same progress. Failures still toast
 * whenever the project is not on screen.
 */
export function silenceProjectCloneToasts(ref: ScopedProjectRef) {
  silenced.add(scopedProjectKey(ref));
}

export function isProjectCloneToastSilenced(ref: ScopedProjectRef): boolean {
  return silenced.has(scopedProjectKey(ref));
}

/** Hands a clone back to its toasts when the user never reached its project. */
export function unsilenceProjectCloneToasts(ref: ScopedProjectRef) {
  if (!silenced.delete(scopedProjectKey(ref))) return;
  version += 1;
  for (const listener of listeners) listener();
}

/** Re-renders when a clone is handed back, since no new clone snapshot may follow. */
export function useProjectCloneToastSilenceVersion(): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => version,
  );
}
