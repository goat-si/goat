import { scopeThreadRef } from "@goat/client-runtime/environment";
import {
  GOAT_BOT_READING_LIMIT_MS,
  advanceGoatBotFace,
  goatBotFaceKey,
  goatBotFaceTasks,
  goatBotItemReaders,
  goatBotReplyingSince,
  type GoatBotFaceInput,
  type GoatBotFaceState,
} from "@goat/client-runtime/goatBot";
import { useState } from "react";

import { useDeadlinePassed } from "../../lib/clock";
import { useThreadShell } from "../../state/entities";
import { useThreadVisibleTurnItems } from "../../state/use-thread-detail";
import { useMobileGoatBotHomeMode } from "./useMobileGoatBotHomeMode";

/**
 * The main bot's face, from its conversation shell and the task chips in its conversation, which
 * the roster and chat already hold. Mobile has no waiting badge, so every waiting chip counts.
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
  // The bot's own reply turns carry no chip, so reading comes from the unanswered message.
  const replyingSince = goatBotReplyingSince({
    visibleTurnItems: items,
    readers: goatBotItemReaders,
  });
  const readingUntil =
    replyingSince === null ? Number.NaN : Date.parse(replyingSince) + GOAT_BOT_READING_LIMIT_MS;
  const readingOver = useDeadlinePassed(Number.isFinite(readingUntil) ? readingUntil : null);
  const reading = Number.isFinite(readingUntil) && !readingOver;
  const input: GoatBotFaceInput = {
    activity: activity ?? (reading ? READING : null),
    waitingCount: 0,
    shell: shell?.source ?? null,
    tasks: goatBotFaceTasks(items),
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

const READING = { state: "reading" } as const;
