import { useAtomValue } from "@effect/atom-react";

import { ListIcon, SquareIcon } from "~/components/solar";
import { Button } from "~/components/ui/button";
import { Toggle } from "~/components/ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useThreadRouteTarget } from "~/hooks/useThreadRouteTarget";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { previewSessionsEnvironment, usePreviewSessions } from "~/state/previewSessions";

import { selectAgentCardsShown, usePreviewSessionStack } from "./previewSessionStackStore";
import {
  useAgentScreenSessions,
  useHiddenLiveAgentSessions,
  useStopAllAgents,
} from "./useAgentScreenCards";

/**
 * The header's list button shows or hides this thread's cards, including ones the person closed,
 * while the thread has any. Stop all is the host's kill switch: it shows in every thread while any
 * agent on the host can be stopped, even in a thread with no card of its own.
 */
export function AgentScreenCardsToggle() {
  const threadTarget = useThreadRouteTarget();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const threadRef = threadTarget?.kind === "server" ? threadTarget.threadRef : null;
  const environmentId = threadRef?.environmentId ?? primaryEnvironmentId;
  const sessions = useAgentScreenSessions(environmentId, threadRef);
  const closed = useHiddenLiveAgentSessions(environmentId, threadRef).length;
  // Stop all reaches every agent on the host: other threads' and a tab shown in the mini player.
  const stoppable = usePreviewSessions(environmentId).some((session) =>
    session.capabilities.controls.includes("stop"),
  );
  const shown = usePreviewSessionStack(selectAgentCardsShown) && closed === 0;
  const setShown = usePreviewSessionStack((state) => state.setShown);
  const stopAll = useStopAllAgents(environmentId);
  const canControl = useAtomValue(previewSessionsEnvironment.control.permissionAtom(environmentId));
  if (sessions.length === 0 && closed === 0 && !stoppable) return null;
  return (
    <>
      {stoppable ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                className="shrink-0 [-webkit-app-region:no-drag]"
                variant="ghost-destructive"
                size="icon-sm"
                aria-label="Stop all agents on screen"
                disabled={!canControl}
                onClick={() => void stopAll()}
              />
            }
          >
            <SquareIcon className="size-3.5 fill-current" />
          </TooltipTrigger>
          <TooltipPopup side="bottom">Stops every agent using the screen now</TooltipPopup>
        </Tooltip>
      ) : null}
      {sessions.length === 0 && closed === 0 ? null : (
        <Tooltip>
          <TooltipTrigger render={<span className="flex shrink-0" />}>
            <Toggle
              className="shrink-0 [-webkit-app-region:no-drag]"
              pressed={shown}
              onPressedChange={(next) => setShown(next, threadRef?.threadId)}
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
      )}
    </>
  );
}
