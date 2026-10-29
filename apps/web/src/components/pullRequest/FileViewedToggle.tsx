import { createContext, use, type ReactNode } from "react";
import { Checkbox } from "../ui/checkbox";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface FileViewedToggleState {
  readonly enabled: boolean;
  readonly isViewed: (path: string) => boolean;
  readonly isStale: (path: string) => boolean;
  readonly setFileViewed: (fileKey: string, viewed: boolean, extendRange: boolean) => void;
}

// Context updates viewed toggles without invalidating memoized header portals.
export const FileViewedToggleContext = createContext<FileViewedToggleState | null>(null);

export function FileViewedToggle({
  fileKey,
  path,
  stat,
}: {
  readonly fileKey: string;
  readonly path: string;
  readonly stat: ReactNode;
}) {
  const viewedFiles = use(FileViewedToggleContext);
  if (viewedFiles === null || !viewedFiles.enabled) return stat;
  const viewed = viewedFiles.isViewed(path);
  const stale = viewedFiles.isStale(path);
  return (
    <span className="flex items-center gap-3">
      {stat}
      <label
        data-viewed-toggle=""
        className="flex cursor-pointer select-none items-center gap-1.5 text-2xs text-muted-foreground"
        onClick={(event) => event.stopPropagation()}
      >
        <Checkbox
          aria-label={stale ? "Changed" : "Viewed"}
          checked={viewed}
          onCheckedChange={(next, details) =>
            viewedFiles.setFileViewed(
              fileKey,
              next === true,
              "shiftKey" in details.event && details.event.shiftKey === true,
            )
          }
        />
        {stale ? (
          <Tooltip>
            <TooltipTrigger render={<span className="text-warning-foreground" />}>
              Changed
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              This file has been pushed to since you marked it viewed.
            </TooltipPopup>
          </Tooltip>
        ) : (
          <span className="@max-xs:hidden">Viewed</span>
        )}
      </label>
    </span>
  );
}
