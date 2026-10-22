import { useAtomValue } from "@effect/atom-react";
import { BellIcon, SearchIcon } from "~/components/solar";
import { useSyncExternalStore } from "react";

import { excludeGlobalAgentThreads } from "../../globalAgentRoute";
import { openCommandPalette } from "../../commandPaletteBus";
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
import { requestSidebarSearchFocus } from "./sidebarSearchFocus";

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
  if (publishedPriorityCount !== null) return publishedPriorityCount;
  const index = buildSidebarSubagentIndex(threads);
  const visible = excludeGlobalAgentThreads(
    filterSidebarV2VisibleThreads(threads, null, new Set(index.attentionByOwnerKey.keys())),
    globalAgentRef,
    botRef,
  );
  return countVisibleSidebarPriorityThreads({
    threads: visible,
    now: `${nowMinute}:00.000Z`,
    localLastVisitedAtByKey,
    attentionByOwnerKey: index.attentionByOwnerKey,
    supportsSnooze: (environmentId) =>
      serverConfigs.get(environmentId)?.environment.capabilities.threadSnooze === true,
    supportsSettlement: (environmentId) =>
      serverConfigs.get(environmentId)?.environment.capabilities.threadSettlement === true,
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
  const handleSearch = () => {
    if (!requestSidebarSearchFocus()) openCommandPalette();
  };

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
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              className="relative top-auto translate-y-0"
              aria-label="Search threads"
              onClick={handleSearch}
            >
              <SearchIcon />
            </Button>
          }
        />
        <TooltipPopup side="bottom">Search threads</TooltipPopup>
      </Tooltip>
    </div>
  );
}
