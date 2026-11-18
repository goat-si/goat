import { RedoIcon as Redo2Icon } from "~/components/solar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function UserMessageIntentMarker({
  intent,
  unread,
}: {
  readonly intent: "steer" | "promoted_queued_to_steer";
  readonly unread: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            className="me-1 flex items-center justify-end gap-1 text-xs leading-none text-muted-foreground"
            data-user-message-intent={intent}
          />
        }
      >
        <Redo2Icon aria-hidden="true" className="size-3" />
        {unread ? "Steer · waiting to be read" : "Steer"}
      </TooltipTrigger>
      <TooltipPopup side="top">
        {unread
          ? "Waiting for the agent to read this. It reads steers between steps, after a running command finishes."
          : intent === "promoted_queued_to_steer"
            ? "Originally queued, then promoted to steer the active turn"
            : "Steered the active turn"}
      </TooltipPopup>
    </Tooltip>
  );
}
