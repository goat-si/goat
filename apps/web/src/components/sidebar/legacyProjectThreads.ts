import {
  scopeProjectRef,
  scopeThreadRef,
  scopedProjectKey,
  scopedThreadKey,
} from "@goat/client-runtime/environment";
import type { SidebarThreadPreviewCount, SidebarThreadSortOrder } from "@goat/contracts/settings";
import { useShallow } from "zustand/react/shallow";

import { excludeGlobalAgentThreads } from "../../globalAgentRoute";
import { useGlobalAgentStore } from "../../globalAgentStore";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useClientSettings } from "../../hooks/useSettings";
import { sortThreads } from "../../lib/threadSort";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useThreadShellsForProjectRefs } from "../../state/entities";
import type { SidebarThreadSummary } from "../../types";
import { useUiStateStore } from "../../uiStateStore";
import {
  isProjectsViewListedThread,
  isProjectsViewPinnedThread,
  resolveProjectsViewPreview,
} from "../LegacySidebar.logic";
import {
  resolveProjectStatusIndicator,
  resolveThreadLastVisitedAt,
  resolveThreadStatusPill,
  type SidebarChildAttention,
  withSidebarChildRequest,
} from "../Sidebar.logic";
import { withoutBotThreads } from "./botVisibility";
import { foldLaunchedThreads } from "@goat/client-runtime/state/launch-fold";
import { useBotThreadKeys } from "./useBotThreadKeys";

function resolveProjectThreadStatus(
  thread: SidebarThreadSummary,
  lastVisitedAtByThreadKey: ReadonlyMap<string, string | undefined>,
  childAttentionByKey: ReadonlyMap<string, SidebarChildAttention>,
) {
  const lastVisitedAt = lastVisitedAtByThreadKey.get(
    scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
  );
  return resolveThreadStatusPill({
    thread: {
      ...withSidebarChildRequest(
        thread,
        childAttentionByKey.get(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))),
      ),
      ...(lastVisitedAt !== null && lastVisitedAt !== undefined ? { lastVisitedAt } : {}),
    },
  });
}

const keyOfThread = (thread: Pick<SidebarThreadSummary, "environmentId" | "id">) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

// Separate hooks keep array caches independent of the route-dependent panel.
export function useProjectThreads(
  project: SidebarProjectSnapshot,
  pinnedThreads: readonly SidebarThreadSummary[] | undefined,
  openSubagentOwnerKey: string | undefined,
  childAttentionByKey: ReadonlyMap<string, SidebarChildAttention>,
  /** Logical project of a scoped project key; a launched thread folds only within one. */
  projectKeyByScopedRef: ReadonlyMap<string, string> | undefined,
) {
  const threadSortOrder = useClientSettings<SidebarThreadSortOrder>(
    (settings) => settings.sidebarThreadSortOrder,
  );
  const sidebarThreads = useThreadShellsForProjectRefs(project.memberProjectRefs);
  const globalAgentRef = useGlobalAgentStore((state) => state.ref);
  const goatBotRef = useGlobalAgentStore((state) => state.botRef);
  // Counts and lookups keep GOAT Bot's threads, so removing a project still sees them.
  const { hidden: hiddenBotThreadKeys } = useBotThreadKeys();
  const projectThreads = pinnedThreads ?? sidebarThreads;
  const threadLastVisitedAts = useUiStateStore(
    useShallow((state) =>
      projectThreads.map(
        (thread) =>
          state.threadLastVisitedAtById[
            scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))
          ] ?? null,
      ),
    ),
  );
  const sidebarThreadByKey = new Map(
    sidebarThreads.map(
      (thread) =>
        [scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)), thread] as const,
    ),
  );
  const memberProjectByScopedKey = new Map(
    project.memberProjects.map((member) => [
      scopedProjectKey(scopeProjectRef(member.environmentId, member.id)),
      member,
    ]),
  );
  const memberThreadCountByPhysicalKey = new Map<string, number>(
    project.memberProjects.map((member) => [member.physicalProjectKey, 0] as const),
  );
  for (const thread of projectThreads) {
    const member = memberProjectByScopedKey.get(
      scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
    );
    if (!member) {
      continue;
    }
    memberThreadCountByPhysicalKey.set(
      member.physicalProjectKey,
      (memberThreadCountByPhysicalKey.get(member.physicalProjectKey) ?? 0) + 1,
    );
  }
  const lastVisitedAtByThreadKey = new Map(
    projectThreads.map((thread, index) => [
      scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      resolveThreadLastVisitedAt(thread.lastVisitedAt, threadLastVisitedAts[index] ?? undefined),
    ]),
  );
  const listedInProjects = sortThreads(
    withoutBotThreads(
      excludeGlobalAgentThreads(
        sidebarThreads.filter((thread) => {
          const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
          return isProjectsViewListedThread(
            thread,
            childAttentionByKey.has(key) || openSubagentOwnerKey === key,
          );
        }),
        globalAgentRef,
        goatBotRef,
      ),
      hiddenBotThreadKeys,
    ),
    threadSortOrder,
  );
  const listedThreads = pinnedThreads ?? listedInProjects;
  const nowMinute = useNowMinute();
  // Launched threads fold under their launcher, pinned or not; the project status still counts
  // them. The pinned section shows pinned roots and a project list the rest.
  const pinnedRoots = withoutBotThreads(
    pinnedThreads ?? sidebarThreads.filter(isProjectsViewPinnedThread),
    hiddenBotThreadKeys,
  );
  const pinnedKeys = new Set(pinnedRoots.map(keyOfThread));
  const logicalProjectOf = (thread: SidebarThreadSummary) => {
    const key = scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId));
    return projectKeyByScopedRef?.get(key) ?? key;
  };
  const launchFold = foldLaunchedThreads({
    visible: [...listedInProjects, ...pinnedRoots],
    all: sidebarThreads,
    now: `${nowMinute}:00.000Z`,
    delegatedAttentionByKey: childAttentionByKey,
    sameList: (child, parent) => logicalProjectOf(child) === logicalProjectOf(parent),
  });
  const visibleProjectThreads = (pinnedThreads ?? launchFold.roots).filter(
    (thread) =>
      pinnedKeys.has(keyOfThread(thread)) === (pinnedThreads !== undefined) &&
      !launchFold.parentKeyByKey.has(keyOfThread(thread)),
  );
  const projectStatus = resolveProjectStatusIndicator(
    listedThreads.map((thread) =>
      resolveProjectThreadStatus(thread, lastVisitedAtByThreadKey, childAttentionByKey),
    ),
  );
  const orderedProjectThreadKeys = visibleProjectThreads.map((thread) =>
    scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
  );
  return {
    sidebarThreads,
    sidebarThreadByKey,
    memberProjectByScopedKey,
    memberThreadCountByPhysicalKey,
    lastVisitedAtByThreadKey,
    visibleProjectThreads,
    launchFold,
    projectStatus,
    orderedProjectThreadKeys,
  };
}

export function useProjectThreadPanel(input: {
  visibleProjectThreads: readonly SidebarThreadSummary[];
  lastVisitedAtByThreadKey: ReadonlyMap<string, string | undefined>;
  activeRouteThreadKey: string | null;
  openSubagentOwnerKey: string | null;
  projectExpanded: boolean;
  isThreadListExpanded: boolean;
  isPinnedSection: boolean;
  childAttentionByKey: ReadonlyMap<string, SidebarChildAttention>;
}) {
  const {
    visibleProjectThreads,
    lastVisitedAtByThreadKey,
    activeRouteThreadKey,
    openSubagentOwnerKey,
    projectExpanded,
    isThreadListExpanded,
    isPinnedSection,
    childAttentionByKey,
  } = input;
  const sidebarThreadPreviewCount = useClientSettings<SidebarThreadPreviewCount>(
    (settings) => settings.sidebarThreadPreviewCount,
  );
  const activeThreadKey = activeRouteThreadKey ?? undefined;
  const activeThread = activeThreadKey
    ? (visibleProjectThreads.find(
        (thread) =>
          scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === activeThreadKey,
      ) ?? null)
    : null;
  const pinnedCollapsedThread = projectExpanded ? null : activeThread;
  // The open thread stays listed past the preview cut, as it does in a
  // collapsed project, so it alone does not overflow the preview.
  const hasOverflowingThreads =
    !isPinnedSection &&
    visibleProjectThreads.some(
      (thread, index) =>
        index >= sidebarThreadPreviewCount &&
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) !== activeThreadKey,
    );
  const previewThreads =
    isThreadListExpanded || !hasOverflowingThreads
      ? visibleProjectThreads
      : resolveProjectsViewPreview(
          visibleProjectThreads,
          sidebarThreadPreviewCount,
          openSubagentOwnerKey,
          (thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        );
  const visibleThreadKeys = new Set(
    [...previewThreads, ...(activeThread ? [activeThread] : [])].map((thread) =>
      scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
    ),
  );
  const renderedThreads = pinnedCollapsedThread
    ? [pinnedCollapsedThread]
    : visibleProjectThreads.filter((thread) =>
        visibleThreadKeys.has(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))),
      );
  const hiddenThreads = visibleProjectThreads.filter(
    (thread) =>
      !visibleThreadKeys.has(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))),
  );
  return {
    hasOverflowingThreads,
    hiddenThreadStatus: resolveProjectStatusIndicator(
      hiddenThreads.map((thread) =>
        resolveProjectThreadStatus(thread, lastVisitedAtByThreadKey, childAttentionByKey),
      ),
    ),
    renderedThreads,
    showEmptyThreadState: projectExpanded && visibleProjectThreads.length === 0,
    shouldShowThreadPanel: projectExpanded || pinnedCollapsedThread !== null,
  };
}
