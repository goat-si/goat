import type { ReactNode } from "react";

import { cn } from "../lib/utils";
import { THREAD_DETAILS_PANEL_LABEL_CLASS } from "./chat/threadDetailsPanelStyles";

export function ComposerContextLabel({
  children,
  displayMode = "toolbar",
  collapseWhenCompact = true,
}: {
  children: ReactNode;
  displayMode?: "toolbar" | "panel";
  collapseWhenCompact?: boolean;
}) {
  return (
    <span
      data-composer-label
      className={cn(
        "min-w-0",
        displayMode === "panel"
          ? "flex-1 overflow-x-clip overflow-y-visible text-left"
          : cn(
              "max-w-[240px]",
              collapseWhenCompact && "group-data-[compact]/composer-context:max-w-0",
            ),
      )}
    >
      <span
        data-composer-label-motion
        className={cn(
          "block w-full min-w-0 truncate",
          displayMode === "panel" && THREAD_DETAILS_PANEL_LABEL_CLASS,
          displayMode === "toolbar" &&
            cn(
              "max-w-[240px] transition-opacity duration-180 ease-drawer motion-reduce:transition-none",
              collapseWhenCompact && "group-data-[compact]/composer-context:opacity-0",
            ),
        )}
      >
        {children}
      </span>
    </span>
  );
}
