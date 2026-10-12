import { useAtomValue } from "@effect/atom-react";
import { BellDotIcon, BellIcon, SearchIcon } from "lucide-react";
import { useCallback, useMemo } from "react";

import { openCommandPalette } from "../../commandPaletteBus";
import { useGlobalAgentStore } from "../../globalAgentStore";
import { useLegacySidebarEnabled, useUpdateClientSettings } from "../../hooks/useSettings";
import { shortcutLabelForCommand } from "../../keybindings";
import { useThreadShells } from "../../state/entities";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { hasSidebarActivityAttention } from "./SidebarViewToggles.logic";
import { requestSidebarSearchFocus } from "./sidebarSearchFocus";

export function useSidebarActivityToggle() {
  const legacySidebarEnabled = useLegacySidebarEnabled();
  const updateClientSettings = useUpdateClientSettings();
  const toggleActivity = useCallback(
    () => updateClientSettings({ legacySidebarEnabled: !legacySidebarEnabled }),
    [legacySidebarEnabled, updateClientSettings],
  );
  return { activityActive: !legacySidebarEnabled, toggleActivity };
}

export function SidebarViewToggles({ onBackdrop }: { onBackdrop: boolean }) {
  const { activityActive, toggleActivity } = useSidebarActivityToggle();
  const threads = useThreadShells(!activityActive);
  const globalAgentRef = useGlobalAgentStore((state) => state.ref);
  const botRef = useGlobalAgentStore((state) => state.botRef);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const needsAttention = useMemo(
    () => !activityActive && hasSidebarActivityAttention(threads, globalAgentRef, botRef),
    [activityActive, threads, globalAgentRef, botRef],
  );
  const activityLabel = activityActive
    ? "Turn off activity view"
    : needsAttention
      ? "View activity, needs attention"
      : "View activity";
  const shortcutLabel = shortcutLabelForCommand(keybindings, "sidebar.toggleActivity");
  const variant = onBackdrop ? "media-navigation" : "ghost";
  const handleSearch = () => {
    if (!requestSidebarSearchFocus()) openCommandPalette();
  };

  return (
    <div className="relative z-10 flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant={variant}
              size="icon-sm"
              className="relative top-auto translate-y-0"
              aria-label={activityLabel}
              aria-pressed={activityActive}
              data-pressed={activityActive ? "" : undefined}
              onClick={() => void toggleActivity()}
            >
              {needsAttention ? <BellDotIcon /> : <BellIcon />}
            </Button>
          }
        />
        <TooltipPopup side="bottom">
          {activityLabel}
          {shortcutLabel ? ` (${shortcutLabel})` : ""}
        </TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant={variant}
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
