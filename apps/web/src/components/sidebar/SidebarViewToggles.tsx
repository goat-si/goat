import { SearchIcon } from "lucide-react";
import { useCallback } from "react";

import { openCommandPalette } from "../../commandPaletteBus";
import { useLegacySidebarEnabled, useUpdateClientSettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { requestSidebarSearchFocus } from "./sidebarSearchFocus";

export function useSidebarActivityToggle() {
  const projectsSidebar = useLegacySidebarEnabled();
  const updateClientSettings = useUpdateClientSettings();
  const toggleActivity = useCallback(async () => {
    if (projectsSidebar === null) return;
    await updateClientSettings({ legacySidebarEnabled: !projectsSidebar });
  }, [projectsSidebar, updateClientSettings]);
  return { activityActive: projectsSidebar === false, toggleActivity };
}

/** Focuses Activity's inline thread search, or opens the command palette elsewhere. */
export function SidebarSearchButton({ onBackdrop }: { onBackdrop: boolean }) {
  const handleSearch = () => {
    if (!requestSidebarSearchFocus()) openCommandPalette();
  };

  return (
    <div className="relative z-10 flex shrink-0 items-center [-webkit-app-region:no-drag]">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant={onBackdrop ? "media-navigation" : "ghost"}
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
