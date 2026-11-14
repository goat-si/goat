import { ChevronDown, ChevronRight } from "~/components/solar/nodes";
import { MorphIcon } from "~/components/MorphIcon";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

export function DiffFileCollapseToggle({
  filePath,
  fileKey,
  collapsed,
  unavailable,
  iconClassName,
  onToggle,
}: {
  filePath: string;
  fileKey: string;
  collapsed: boolean;
  unavailable: boolean;
  iconClassName: string;
  onToggle: (fileKey: string) => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-micro"
            variant="ghost"
            className="-ms-0.5"
            aria-label={collapsed ? `Expand ${filePath}` : `Collapse ${filePath}`}
            aria-expanded={!collapsed}
            disabled={unavailable}
            onClick={(event) => {
              event.stopPropagation();
              onToggle(fileKey);
            }}
          />
        }
      >
        <MorphIcon
          className={cn("size-4", iconClassName)}
          icon={collapsed ? ChevronRight : ChevronDown}
        />
      </TooltipTrigger>
      <TooltipPopup side="top">{collapsed ? "Expand diff" : "Collapse diff"}</TooltipPopup>
    </Tooltip>
  );
}
