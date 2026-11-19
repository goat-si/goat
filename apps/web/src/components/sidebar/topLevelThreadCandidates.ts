import { paletteListedThreads } from "@goat/client-runtime/state/launch-fold";
import { effectiveSnoozed } from "@goat/client-runtime/state/thread-settled";
import type { Thread } from "../../types";

export function topLevelThreadCandidates<T extends Thread>(
  threads: readonly T[],
  now = new Date().toISOString(),
): readonly T[] {
  return paletteListedThreads(threads, now).filter(
    (thread) => thread.settledOverride !== "settled" && !effectiveSnoozed(thread, { now }),
  );
}
