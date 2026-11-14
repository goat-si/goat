import type { ReactNode } from "react";
import { cn } from "~/lib/utils";
import { useMobileSidebarSheetMounted } from "../ui/sidebar";

export function PullRequestPanelControls({ children }: { readonly children: ReactNode }) {
  const sidebarMounted = useMobileSidebarSheetMounted();
  return (
    <div
      className={cn(
        "absolute top-[var(--workspace-controls-top)] right-[var(--workspace-controls-right)] z-50 mr-px flex h-[var(--workspace-topbar-height)] items-center gap-1 [-webkit-app-region:no-drag]",
        sidebarMounted && "hidden",
      )}
      data-workspace-titlebar-controls
    >
      {children}
    </div>
  );
}
