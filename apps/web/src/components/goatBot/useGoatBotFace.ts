import { deadlineStore } from "@goat/client-runtime/clock";
import {
  GOAT_BOT_READING_LIMIT_MS,
  advanceGoatBotFace,
  goatBotFaceKey,
  goatBotFaceTasks,
  goatBotItemReaders,
  goatBotReplyingSince,
  observeResidentAtom,
  residentAtomValue,
  type GoatBotFaceInput,
  type GoatBotFaceState,
} from "@goat/client-runtime/goatBot";
import type { ScopedThreadRef } from "@goat/contracts";
import { useState, useSyncExternalStore } from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useThreadShell } from "~/state/entities";
import { environmentThreadDetails } from "~/state/threads";

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

/** The conversation's items only while another view keeps them loaded; never loads them. */
function useResidentVisibleItems(ref: ScopedThreadRef | null) {
  const atom = ref === null ? null : environmentThreadDetails.threadAtom(ref);
  const resident = atom !== null && residentAtomValue(appAtomRegistry, atom) !== null;
  const subscribe = (onChange: () => void) =>
    atom === null || !resident ? () => {} : observeResidentAtom(appAtomRegistry, atom, onChange);
  const thread = useSyncExternalStore(subscribe, () =>
    atom === null ? null : residentAtomValue(appAtomRegistry, atom),
  );
  return thread?.projection?.visibleTurnItems ?? null;
}

/**
 * A bot's face from its conversation: the shell every client streams, and its task chips while
 * the sidebar or chat already holds them. The bot's own reply turns carry no chip, so reading
 * comes from the unanswered message in those same items.
 */
export function useGoatBotSessionFace(
  threadRef: ScopedThreadRef | null,
  waitingCount: number,
  activity: GoatBotFaceInput["activity"],
): GoatBotFaceState {
  const shell = useThreadShell(threadRef);
  const items = useResidentVisibleItems(threadRef);
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
