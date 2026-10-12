import { scopeThreadRef, scopedThreadKey } from "@goat/client-runtime/environment";
import type { EnvironmentThreadShell } from "@goat/client-runtime/state/shell";
import type { ChannelBotRef } from "@goat/contracts";

import { excludeGlobalAgentThreads } from "../../globalAgentRoute";
import type { GlobalAgentRef } from "../../globalAgentStore";
import {
  buildSidebarSubagentIndex,
  filterSidebarV2VisibleThreads,
  resolveSidebarThreadStatus,
} from "../Sidebar.logic";

/** Attention belongs to a visible thread, including requests from its delegated tasks. */
export function hasSidebarActivityAttention(
  threads: readonly EnvironmentThreadShell[],
  globalAgentRef: GlobalAgentRef | null,
  botRef: ChannelBotRef | null = null,
): boolean {
  const childAttention = buildSidebarSubagentIndex(threads).attentionByOwnerKey;
  return excludeGlobalAgentThreads(
    filterSidebarV2VisibleThreads(threads, null),
    globalAgentRef,
    botRef,
  ).some((thread) => {
    if (thread.deletedAt !== null) return false;
    const status = resolveSidebarThreadStatus(thread);
    return (
      status === "approval" ||
      status === "input" ||
      childAttention.has(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)))
    );
  });
}
