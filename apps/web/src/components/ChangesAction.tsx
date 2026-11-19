import { formatDiffCount } from "@goat/client-runtime/diff-count";
import { FileDiffIcon } from "~/components/solar";
import { cn } from "~/lib/utils";
import { ThreadDetailsControl } from "./chat/ThreadDetailsControl";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
} from "./chat/threadDetailsPanelStyles";
import type { ChangesLineTotals } from "./GitActionsControl.logic";

export function ChangesAction({
  changesTotals,
  onOpenChanges,
}: {
  changesTotals: ChangesLineTotals;
  onOpenChanges?: () => void;
}) {
  return (
    <ThreadDetailsControl
      type="button"
      variant="ghost"
      size="sm"
      part="row"
      disabled={!onOpenChanges}
      onClick={onOpenChanges}
    >
      <FileDiffIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
      <span className={cn("flex-1 text-left", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
        Changes {changesTotals.baseRef === null ? "(Uncommitted)" : `(vs ${changesTotals.baseRef})`}
      </span>
      <span className="flex items-center gap-1.5 font-mono text-xs tabular-nums">
        <span
          className={
            changesTotals.insertions ? "text-diff-addition-foreground" : "text-muted-foreground"
          }
        >
          +{formatDiffCount(changesTotals.insertions)}
        </span>
        <span
          className={
            changesTotals.deletions ? "text-diff-deletion-foreground" : "text-muted-foreground"
          }
        >
          -{formatDiffCount(changesTotals.deletions)}
        </span>
      </span>
    </ThreadDetailsControl>
  );
}
