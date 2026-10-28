import { scopeThreadRef, scopedThreadKey } from "@goat/client-runtime/environment";
import { threadWokeAt } from "@goat/client-runtime/state/thread-settled";
import type { EnvironmentId, ThreadId } from "@goat/contracts";

import {
  isSidebarPriorityMember,
  resolveSidebarWokeAtForRow,
  type SidebarPriorityHolds,
} from "../Sidebar.logic";
import type { SidebarPriorityReadPlan } from "./priorityRead";

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

/** Whether a thread would sit in Priority on its own row; launch folds lift its launcher if so. */
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
    return isSidebarPriorityMember({
      thread,
      now: input.now,
      localLastVisitedAt: input.localLastVisitedAtByKey[key],
      hasChildAttention: false,
      ...(input.wakes?.has(key) === true ? { wokeAt: input.wakes.get(key) ?? null } : {}),
      supportsSnooze: capabilities?.threadSnooze === true,
      supportsSettlement: capabilities?.threadSettlement === true,
    });
  };
}

/**
 * Reads the unread work folded under Priority rows along with a plan: each row's operable folded
 * unread threads are visited, and a failed visit restores the row. A row is released when the plan
 * already releases it or it sits in Priority only through that work; attention and working lifts
 * keep it there either way.
 */
export function withFoldedUnseen<T extends Keyed>(
  plan: SidebarPriorityReadPlan<T>,
  input: {
    readonly rows: readonly T[];
    readonly unseenUnder: (key: string) => readonly T[];
    readonly canOperate: (thread: T) => boolean;
    readonly liftedOnly: (row: T) => boolean;
  },
): SidebarPriorityReadPlan<T> {
  const markRead = [...plan.markRead];
  const releaseKeys = [...plan.releaseKeys];
  const visiting = new Set(markRead.map(keyOf));
  const restoreKeyByKey = new Map(plan.restoreKeyByKey ?? []);
  for (const row of input.rows) {
    const rowKey = keyOf(row);
    const children = input.unseenUnder(rowKey).filter(input.canOperate);
    if (children.length === 0) continue;
    for (const child of children) {
      const childKey = keyOf(child);
      if (!visiting.has(childKey)) {
        visiting.add(childKey);
        markRead.push(child);
      }
      restoreKeyByKey.set(childKey, rowKey);
    }
    if (!releaseKeys.includes(rowKey) && input.liftedOnly(row)) releaseKeys.push(rowKey);
  }
  return { markRead, releaseKeys, restoreKeyByKey };
}
