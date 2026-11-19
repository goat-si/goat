import { paletteListedThreads } from "@goat/client-runtime/state/launch-fold";
import { effectiveSnoozed } from "@goat/client-runtime/state/thread-settled";
import { scopeThreadRef, scopedThreadKey } from "@goat/client-runtime/environment";
import type { Thread } from "../../types";

export function topLevelThreadCandidates<T extends Thread>(
  threads: readonly T[],
  now = new Date().toISOString(),
  hiddenParentKeys: ReadonlySet<string> = new Set(),
): readonly T[] {
  return paletteListedThreads(threads, now, hiddenParentKeys).filter(
    (thread) =>
      !hiddenParentKeys.has(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))) &&
      thread.settledOverride !== "settled" &&
      !effectiveSnoozed(thread, { now }),
  );
}
