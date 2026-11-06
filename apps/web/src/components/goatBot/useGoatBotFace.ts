import { deadlineStore } from "@goat/client-runtime/clock";
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
import type { ScopedThreadRef } from "@goat/contracts";
import { useState, useSyncExternalStore } from "react";

import {
  resolveThreadDetailRef,
  useThreadShell,
  useThreadVisibleTurnItems,
} from "~/state/entities";

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

/**
 * A bot's face from its conversation: the shell every client streams and, when the caller says a
 * view already holds the conversation (the bot-mode sidebar row, the open chat), its task chips.
 * Reading the same detail atom adds no load there. The bot's own reply turns carry no chip, so
 * reading comes from the unanswered message in those items.
 */
export function useGoatBotSessionFace(
  threadRef: ScopedThreadRef | null,
  waitingCount: number,
  activity: GoatBotFaceInput["activity"],
  held: boolean,
): GoatBotFaceState {
  const shell = useThreadShell(threadRef);
  const detailRef = held
    ? resolveThreadDetailRef(threadRef, { shellExists: shell !== null, waitForShell: true })
    : null;
  const visible = useThreadVisibleTurnItems(detailRef);
  const items = detailRef === null ? null : visible;
  const reading = useGoatBotReading(
    items === null
      ? null
      : goatBotReplyingSince({ visibleTurnItems: items, readers: goatBotItemReaders }),
  );
  return useGoatBotFaceState({
    activity: activity ?? (reading ? READING : null),
    waitingCount,
    shell: shell?.source ?? null,
    tasks: items === null ? null : goatBotFaceTasks(items),
  });
}

const READING = { state: "reading" } as const;

/** True from when GOAT Bot starts reading a message until it answers or the limit passes. */
export function useGoatBotReading(replyingSince: string | null): boolean {
  const deadline =
    replyingSince === null ? null : Date.parse(replyingSince) + GOAT_BOT_READING_LIMIT_MS;
  const valid = deadline !== null && Number.isFinite(deadline);
  return !useDeadlinePassed(valid ? deadline : null) && valid;
}
