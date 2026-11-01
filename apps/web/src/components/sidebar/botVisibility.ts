import { scopeThreadRef, scopedThreadKey } from "@goat/client-runtime/environment";
import { type EnvironmentId, isSideChatThread, type ThreadId } from "@goat/contracts";

import type { SidebarThreadSummary } from "../../types";
import { isInSidebarProjectScope, type SidebarProjectScopeInput } from "./projectScope";

type Keyed = { readonly environmentId: EnvironmentId; readonly id: ThreadId };

const keyOf = (thread: Keyed) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

/** The list without GOAT Bot's observation threads; `hidden` is empty once the user shows them. */
export function withoutBotThreads<T extends Keyed>(
  threads: readonly T[],
  hidden: ReadonlySet<string>,
): readonly T[] {
  return hidden.size === 0 ? threads : threads.filter((thread) => !hidden.has(keyOf(thread)));
}

/**
 * Search still reaches GOAT Bot's observation threads, subagents included, in the same project
 * scope as the list. Other subagents stay out of search as before.
 */
export function withBotSearchCandidates<
  T extends Keyed &
    SidebarProjectScopeInput &
    Pick<SidebarThreadSummary, "archivedAt" | "sideChatOf"> & { readonly deletedAt?: unknown },
>(
  listed: readonly T[],
  threads: readonly T[],
  observation: ReadonlySet<string>,
  scopedProjectKeys: ReadonlySet<string> | null,
): readonly T[] {
  if (observation.size === 0) return listed;
  const listedKeys = new Set(listed.map(keyOf));
  const extra = threads.filter(
    (thread) =>
      observation.has(keyOf(thread)) &&
      !listedKeys.has(keyOf(thread)) &&
      thread.deletedAt == null &&
      thread.archivedAt === null &&
      !isSideChatThread(thread) &&
      isInSidebarProjectScope(thread, scopedProjectKeys),
  );
  return extra.length === 0 ? listed : [...listed, ...extra];
}
