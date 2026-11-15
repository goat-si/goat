import { scopedThreadKey, scopeThreadRef } from "@goat/client-runtime/environment";
import type { EnvironmentThreadShell } from "@goat/client-runtime/state/shell";
import { asLaunchingThread } from "@goat/client-runtime/state/thread-inbox";
import { useShallow } from "zustand/react/shallow";
import { useComposerDraftStore } from "../../composerDraftStore";

/** Threads a sent draft is launching into: from their shell's arrival until the server owns the send. */
function usePromotingDraftThreadKeys(): ReadonlyArray<string> {
  return useComposerDraftStore(
    useShallow((state) =>
      Object.values(state.draftThreadsByThreadKey).flatMap((draft) =>
        draft.promotedTo ? [scopedThreadKey(draft.promotedTo)] : [],
      ),
    ),
  );
}

/** The sidebar's threads, with those a sent draft is launching into placed as working. */
export function useLaunchingSidebarThreads<T extends EnvironmentThreadShell>(
  threads: ReadonlyArray<T>,
): ReadonlyArray<T> {
  const promotingDraftThreadKeys = usePromotingDraftThreadKeys();
  return promotingDraftThreadKeys.length === 0
    ? threads
    : threads.map((thread) =>
        promotingDraftThreadKeys.includes(
          scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        )
          ? asLaunchingThread(thread)
          : thread,
      );
}

/** A runtime on the arranged copy but not the run-less live shell is the list's launch overlay. */
export function rowThreadWithLaunch<T extends EnvironmentThreadShell>(
  arranged: T,
  live: T | null,
): T {
  if (live === null) return arranged;
  return arranged.runtime !== null ? asLaunchingThread(live) : live;
}
