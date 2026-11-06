import { deadlineStore } from "@goat/client-runtime/clock";
import {
  GOAT_BOT_READING_LIMIT_MS,
  advanceGoatBotFace,
  goatBotFaceKey,
  type GoatBotFaceInput,
  type GoatBotFaceState,
} from "@goat/client-runtime/goatBot";
import type { ScopedThreadRef } from "@goat/contracts";
import { useState, useSyncExternalStore } from "react";

import { useThreadShell } from "~/state/entities";

function useDeadlinePassed(deadlineMs: number | null): boolean {
  const store = deadlineStore(deadlineMs);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/**
 * The face to show. It re-reads the clock only when the inputs change or a hold, the finished
 * beat or the sleep threshold passes, so an idle face never re-renders on its own.
 */
function useGoatBotFaceState(input: GoatBotFaceInput): GoatBotFaceState {
  const key = goatBotFaceKey(input);
  // The clock is read inside the updaters so a restarted render gets the current time.
  const [track, setTrack] = useState(() => advanceGoatBotFace(null, input, Date.now()));
  const due = useDeadlinePassed(track.wakeAt);
  if (track.key !== key || due) {
    setTrack((previous) => advanceGoatBotFace(previous, input, Date.now()));
  }
  return track.hold.shown;
}

/** A bot's face from its session thread shell, which every client already streams. */
export function useGoatBotSessionFace(
  threadRef: ScopedThreadRef | null,
  waitingCount: number,
  activity: GoatBotFaceInput["activity"],
): GoatBotFaceState {
  const shell = useThreadShell(threadRef);
  return useGoatBotFaceState({ activity, waitingCount, shell: shell?.source ?? null });
}

/** True from when GOAT Bot starts reading a message until it answers or the limit passes. */
export function useGoatBotReading(replyingSince: string | null): boolean {
  const deadline =
    replyingSince === null ? null : Date.parse(replyingSince) + GOAT_BOT_READING_LIMIT_MS;
  const valid = deadline !== null && Number.isFinite(deadline);
  return !useDeadlinePassed(valid ? deadline : null) && valid;
}
