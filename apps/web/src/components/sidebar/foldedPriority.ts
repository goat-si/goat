import { scopeThreadRef, scopedThreadKey } from "@goat/client-runtime/environment";
import { threadWokeAt } from "@goat/client-runtime/state/thread-settled";
import type { EnvironmentId, ThreadId } from "@goat/contracts";

import {
  isSidebarPriorityMember,
  resolveSidebarPriorityRank,
  resolveSidebarWokeAtForRow,
  type SidebarPriorityHolds,
} from "../Sidebar.logic";

type PriorityMember = Parameters<typeof isSidebarPriorityMember>[0]["thread"];
type Keyed = { readonly environmentId: EnvironmentId; readonly id: ThreadId };

const keyOf = (thread: Keyed) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

/**
 * Each thread's wake as its row would show it, computed before folding so a thread that folds this
 * render still records a settle as acknowledging its wake. Updates `acknowledged` as rows do.
 */
export function wakesBeforeFold<T extends PriorityMember & Keyed>(input: {
  readonly threads: readonly T[];
  readonly now: string;
  readonly holds: SidebarPriorityHolds;
  readonly acknowledged: Set<string>;
  /** A row mid-drop keeps its wake untouched, as the row loop does. */
  readonly skipKey: string | null;
}): ReadonlyMap<string, string | null> {
  const wakes = new Map<string, string | null>();
  for (const thread of input.threads) {
    const key = keyOf(thread);
    if (key === input.skipKey) continue;
    wakes.set(
      key,
      resolveSidebarWokeAtForRow({
        key,
        rawWokeAt: threadWokeAt(thread, { now: input.now }),
        settledOverride: thread.settledOverride,
        heldSettledOverride: input.holds.has(key) ? input.holds.get(key) : undefined,
        acknowledged: input.acknowledged,
      }),
    );
  }
  return wakes;
}

/**
 * Whether a thread would sit in Priority on its own row as unread (rank 2: an unseen completion or
 * wake); launch folds lift its launcher if so. Idle and working rows lift through their own state.
 */
export function foldedPriorityMember<T extends PriorityMember & Keyed>(input: {
  readonly now: string;
  readonly localLastVisitedAtByKey: Readonly<Record<string, string | undefined>>;
  readonly capabilitiesOf: (
    environmentId: EnvironmentId,
  ) => { readonly threadSnooze?: boolean; readonly threadSettlement?: boolean } | undefined;
  /** Effective wakes; without them the raw wake counts, as the activity bell counts rows. */
  readonly wakes?: ReadonlyMap<string, string | null>;
}): (thread: T) => boolean {
  return (thread) => {
    const key = keyOf(thread);
    const capabilities = input.capabilitiesOf(thread.environmentId);
    const localLastVisitedAt = input.localLastVisitedAtByKey[key];
    const wokeAt =
      input.wakes?.has(key) === true
        ? (input.wakes.get(key) ?? null)
        : threadWokeAt(thread, { now: input.now });
    return (
      resolveSidebarPriorityRank({
        thread,
        localLastVisitedAt,
        wokeAt,
        hasChildAttention: false,
      }) === 2 &&
      isSidebarPriorityMember({
        thread,
        now: input.now,
        localLastVisitedAt,
        hasChildAttention: false,
        wokeAt,
        supportsSnooze: capabilities?.threadSnooze === true,
        supportsSettlement: capabilities?.threadSettlement === true,
      })
    );
  };
}
