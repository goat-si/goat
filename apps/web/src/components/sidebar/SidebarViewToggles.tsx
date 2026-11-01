import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@goat/contracts";
import { BellIcon } from "~/components/solar";
import { useSyncExternalStore } from "react";

import { excludeGlobalAgentThreads } from "../../globalAgentRoute";
import { useGlobalAgentStore } from "../../globalAgentStore";
import { useNowMinute } from "../../hooks/useNowMinute";
import { updateClientSettings, useLegacySidebarEnabled } from "../../hooks/useSettings";
import { shortcutLabelForCommand } from "../../keybindings";
import { useThreadShells } from "../../state/entities";
import { environmentServerConfigsAtom, primaryServerKeybindingsAtom } from "../../state/server";
import { useUiStateStore } from "../../uiStateStore";
import {
  buildSidebarSubagentIndex,
  countVisibleSidebarPriorityThreads,
  filterSidebarV2VisibleThreads,
  getPublishedSidebarPriorityCount,
  subscribeSidebarPriorityCount,
} from "../Sidebar.logic";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { withoutBotThreads } from "./botVisibility";
import { foldedPriorityMember } from "./foldedPriority";
import { foldLaunchedThreads } from "@goat/client-runtime/state/launch-fold";
import { useBotThreadKeys } from "./useBotThreadKeys";

export function useSidebarActivityToggle() {
  const projectsSidebar = useLegacySidebarEnabled();
  const toggleActivity = async () => {
    if (projectsSidebar === null) return;
    await updateClientSettings({ projectsSidebarEnabled: !projectsSidebar });
  };
  return { activityActive: projectsSidebar === false, toggleActivity };
}

export function useSidebarPriorityCount() {
  const publishedPriorityCount = useSyncExternalStore(
    subscribeSidebarPriorityCount,
    getPublishedSidebarPriorityCount,
    getPublishedSidebarPriorityCount,
  );
  // Activity publishes the row count, holds included. Otherwise count the same
  // membership Priority will show when it opens.
  const threads = useThreadShells(publishedPriorityCount === null);
  const nowMinute = useNowMinute();
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const localLastVisitedAtByKey = useUiStateStore((state) => state.threadLastVisitedAtById);
  const globalAgentRef = useGlobalAgentStore((state) => state.ref);
  const botRef = useGlobalAgentStore((state) => state.botRef);
  const { hidden: hiddenBotThreadKeys } = useBotThreadKeys();
  if (publishedPriorityCount !== null) return publishedPriorityCount;
  const index = buildSidebarSubagentIndex(threads);
  const visible = withoutBotThreads(
    excludeGlobalAgentThreads(
      filterSidebarV2VisibleThreads(threads, null, new Set(index.attentionByOwnerKey.keys())),
      globalAgentRef,
      botRef,
    ),
    hiddenBotThreadKeys,
  );
  const now = `${nowMinute}:00.000Z`;
  const capabilitiesOf = (id: EnvironmentId) => serverConfigs.get(id)?.environment.capabilities;
  // Activity lists a launcher's folded threads under it, so the bell counts the group once.
  const fold = foldLaunchedThreads({
    visible,
    all: threads,
    now,
    delegatedAttentionByKey: index.attentionByOwnerKey,
    unseen: foldedPriorityMember({ now, localLastVisitedAtByKey, capabilitiesOf }),
  });
  const attentionByOwnerKey = new Map(index.attentionByOwnerKey);
  const childWorkKeys = new Set<string>();
  const childUnseenKeys = new Set<string>();
  for (const [key, lift] of fold.liftByKey) {
    if (lift === "working") childWorkKeys.add(key);
    else if (lift === "unseen") childUnseenKeys.add(key);
    else if (!attentionByOwnerKey.has(key)) attentionByOwnerKey.set(key, lift);
  }
  return countVisibleSidebarPriorityThreads({
    threads: fold.roots,
    now,
    localLastVisitedAtByKey,
    attentionByOwnerKey,
    childWorkKeys,
    childUnseenKeys,
    supportsSnooze: (environmentId) => capabilitiesOf(environmentId)?.threadSnooze === true,
    supportsSettlement: (environmentId) => capabilitiesOf(environmentId)?.threadSettlement === true,
  });
}

/** The header and its width probe subscribe to the same count and measure the same badge. */
export function SidebarPriorityCountBadge({ priorityCount }: { priorityCount: number }) {
  return priorityCount > 0 ? (
    <span className="min-w-4 text-center text-xs text-secondary-label tabular-nums">
      {priorityCount}
    </span>
  ) : null;
}

export function SidebarViewToggles() {
  const { activityActive, toggleActivity } = useSidebarActivityToggle();
  const priorityCount = useSidebarPriorityCount();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const activityLabel = activityActive ? "Turn off activity view" : "View activity";
  const activityName =
    priorityCount > 0 ? `${activityLabel}, ${priorityCount} in Priority` : activityLabel;
  const shortcutLabel = shortcutLabelForCommand(keybindings, "sidebar.toggleActivity");

  return (
    <div className="relative z-10 flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              className="relative top-auto translate-y-0"
              aria-label={activityName}
              aria-pressed={activityActive}
              data-pressed={activityActive ? "" : undefined}
              onClick={() => void toggleActivity()}
            >
              <BellIcon />
            </Button>
          }
        />
        <TooltipPopup side="bottom">
          {activityName}
          {shortcutLabel ? ` (${shortcutLabel})` : ""}
        </TooltipPopup>
      </Tooltip>
      <SidebarPriorityCountBadge priorityCount={priorityCount} />
    </div>
  );
}
