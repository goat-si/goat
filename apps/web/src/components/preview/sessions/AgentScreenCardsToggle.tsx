import type { EnvironmentId, ScopedThreadRef } from "@goat/contracts";

import { ListIcon } from "~/components/solar";
import { Toggle } from "~/components/ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

import { selectAgentCardsShown, usePreviewSessionStack } from "./previewSessionStackStore";
import { useAgentScreenSessions } from "./useAgentScreenCards";

/**
 * The header button that shows or hides the agents-on-screen cards, as Aside's list button does.
 * It exists only while there is a card to show; in a narrow pane it shows them over the thread.
 */
export function AgentScreenCardsToggle(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef | null;
}) {
  const sessions = useAgentScreenSessions(props.environmentId, props.threadRef);
  const shown = usePreviewSessionStack(selectAgentCardsShown);
  const setShown = usePreviewSessionStack((state) => state.setShown);
  if (sessions.length === 0) return null;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="flex shrink-0" />}>
        <Toggle
          className="shrink-0 [-webkit-app-region:no-drag]"
          pressed={shown}
          onPressedChange={setShown}
          aria-label="Agents on screen"
          variant="ghost"
          size="sm"
        >
          <ListIcon className="size-4" />
        </Toggle>
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        {shown ? "Hide agents on screen" : "Show agents on screen"}
      </TooltipPopup>
    </Tooltip>
  );
}
