import { useGT } from "gt-react";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export function AddProjectSourceSetupBadge({
  hint,
  onOpenSettings,
}: {
  readonly hint: string | null;
  readonly onOpenSettings: () => void;
}) {
  const gt = useGT();
  return (
    <span className="ml-auto">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button variant="warning-outline" size="micro" onClick={onOpenSettings}>
              {gt("Setup Required")}
            </Button>
          }
        />
        <TooltipPopup align="end" side="left">
          {hint ?? gt("Open Settings → Source control to configure this provider.")}
        </TooltipPopup>
      </Tooltip>
    </span>
  );
}
