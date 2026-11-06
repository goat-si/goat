import { scopeThreadRef } from "@goat/client-runtime/environment";
import {
  advanceGoatBotFace,
  goatBotFaceKey,
  goatBotWaitingTaskCount,
  type GoatBotFaceInput,
  type GoatBotFaceState,
} from "@goat/client-runtime/goatBot";
import { useState } from "react";

import { useDeadlinePassed } from "../../lib/clock";
import { useThreadShell } from "../../state/entities";
import { useThreadVisibleTurnItems } from "../../state/use-thread-detail";
import { useMobileGoatBotHomeMode } from "./useMobileGoatBotHomeMode";

/**
 * The main bot's face, from its session shell and the task chips in its conversation, which the
 * roster and chat already hold. Mobile has no waiting badge, so it counts every waiting chip.
 */
export function useMobileGoatBotFace(activity: GoatBotFaceInput["activity"]): GoatBotFaceState {
  const { botRef } = useMobileGoatBotHomeMode();
  const shell = useThreadShell(
    botRef ? scopeThreadRef(botRef.environmentId, botRef.threadId) : null,
  );
  const items = useThreadVisibleTurnItems({
    environmentId: botRef?.environmentId ?? null,
    threadId: botRef?.threadId ?? null,
  });
  const input: GoatBotFaceInput = {
    activity,
    waitingCount: goatBotWaitingTaskCount(items),
    shell: shell?.source ?? null,
  };
  const key = goatBotFaceKey(input);
  // The clock is read inside the updaters so a restarted render gets the current time.
  const [track, setTrack] = useState(() => advanceGoatBotFace(null, input, Date.now()));
  const due = useDeadlinePassed(track.wakeAt);
  if (track.key !== key || due) {
    setTrack((previous) => advanceGoatBotFace(previous, input, Date.now()));
  }
  return track.hold.shown;
}
