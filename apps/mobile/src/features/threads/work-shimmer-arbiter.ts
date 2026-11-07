import { createContext, useContext, useEffect, useState, useSyncExternalStore } from "react";

/**
 * At most one shimmer moves on a thread screen (design-system decision). The label in the
 * latest feed entry wins; labels outside feed entries rank -1 and ties go to the newest claim.
 */
export interface WorkShimmerArbiter {
  readonly claim: (label: number, rank: number) => void;
  readonly release: (label: number) => void;
  readonly owner: () => number | null;
  readonly subscribe: (listener: () => void) => () => void;
}

export function createWorkShimmerArbiter(): WorkShimmerArbiter {
  const claims = new Map<number, { readonly rank: number; readonly seq: number }>();
  const listeners = new Set<() => void>();
  let seq = 0;
  let owner: number | null = null;
  const settle = () => {
    let next: number | null = null;
    let best = { rank: -Infinity, seq: -Infinity };
    for (const [label, entry] of claims) {
      if (entry.rank > best.rank || (entry.rank === best.rank && entry.seq > best.seq)) {
        next = label;
        best = entry;
      }
    }
    if (next === owner) return;
    owner = next;
    for (const listener of listeners) listener();
  };
  return {
    claim: (label, rank) => {
      seq += 1;
      claims.set(label, { rank, seq });
      settle();
    },
    release: (label) => {
      if (claims.delete(label)) settle();
    },
    owner: () => owner,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export const WorkShimmerArbiterContext = createContext<WorkShimmerArbiter | null>(null);
/** The index of the feed entry a label renders in; -1 outside feed entries. */
export const FeedEntryShimmerContext = createContext(-1);

let lastLabel = 0;
const nextLabel = () => ++lastLabel;
const subscribeNothing = () => () => {};
const ownerNothing = () => null;

/** Whether this label may run its shimmer now. Without an arbiter every eligible label may. */
export function useWorkShimmerTurn(eligible: boolean): boolean {
  const arbiter = useContext(WorkShimmerArbiterContext);
  const rank = useContext(FeedEntryShimmerContext);
  const [label] = useState(nextLabel);
  // oxlint-disable-next-line goat/react-effect-budget -- holds this label's claim in the screen's shimmer arbiter while it may animate
  useEffect(() => {
    if (arbiter === null || !eligible) return;
    arbiter.claim(label, rank);
    return () => arbiter.release(label);
  }, [arbiter, eligible, label, rank]);
  const owner = useSyncExternalStore(
    arbiter?.subscribe ?? subscribeNothing,
    arbiter?.owner ?? ownerNothing,
  );
  return arbiter === null ? eligible : eligible && owner === label;
}
