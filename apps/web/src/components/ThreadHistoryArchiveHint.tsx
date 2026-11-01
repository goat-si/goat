import type { OrchestrationV2ThreadHistoryArchive } from "@goat/contracts";

import { ArchiveIcon } from "~/components/solar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const LABELS = {
  archived: {
    text: "archived",
    detail: "Tool history archived, restores on open",
  },
  deleted: {
    text: "history deleted",
    detail: "Archived tool history was deleted by the storage policy",
  },
} as const;

/**
 * Says that a thread's tool history is outside the database before anyone opens it. Title rows
 * have room for an icon only; the detail lives in the tooltip either way.
 */
export function ThreadHistoryArchiveHint(props: {
  readonly state: OrchestrationV2ThreadHistoryArchive | undefined;
  readonly variant: "icon" | "text";
  readonly className?: string;
}) {
  if (props.state === undefined) return null;
  const label = LABELS[props.state];
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          props.variant === "icon" ? (
            <span role="img" aria-label={label.detail} className={props.className}>
              <ArchiveIcon aria-hidden className="size-3" />
            </span>
          ) : (
            <span className={props.className}>{label.text}</span>
          )
        }
      />
      <TooltipPopup side="top">{label.detail}</TooltipPopup>
    </Tooltip>
  );
}
