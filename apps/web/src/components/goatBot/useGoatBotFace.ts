import { deadlineStore } from "@goat/client-runtime/clock";
import {
  GOAT_BOT_READING_LIMIT_MS,
  advanceGoatBotFace,
  createFaceMotionArbiter,
  faceMotionEligible,
  goatBotFaceKey,
  goatBotFaceMotion,
  goatBotFaceTasks,
  goatBotItemReaders,
  goatBotReplyingSince,
  goatBotRowFaceSignals,
  goatBotRowReadingUntil,
  type FaceMotion,
  type GoatBotFaceInput,
  type GoatBotFaceState,
  type GoatBotRowStatus,
} from "@goat/client-runtime/goatBot";
import type { ScopedThreadRef } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import { useEffect, useState, useSyncExternalStore } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { useNowAfter } from "~/hooks/useDeadline";
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
 * A bot's face from its conversation shell plus, where a view already holds the conversation, its
 * task chips and unanswered message (no added load). A roster row that does not hold it passes its
 * bot status instead.
 */
export function useGoatBotSessionFace(
  threadRef: ScopedThreadRef | null,
  waitingCount: number,
  activity: GoatBotFaceInput["activity"],
  held: boolean,
  row?: GoatBotRowStatus,
): { readonly state: GoatBotFaceState; readonly since: number | null } {
  const shell = useThreadShell(threadRef);
  const detailRef = held
    ? resolveThreadDetailRef(threadRef, { shellExists: shell !== null, waitForShell: true })
    : null;
  const visible = useThreadVisibleTurnItems(detailRef);
  const items = detailRef === null ? null : visible;
  const replyingSince =
    items === null
      ? null
      : goatBotReplyingSince({ visibleTurnItems: items, readers: goatBotItemReaders });
  const reading = useGoatBotReading(replyingSince);
  const rowStatus = items === null ? row : undefined;
  // One timer: the clock is read again when the row's reading window closes.
  const now = useNowAfter(rowStatus === undefined ? null : goatBotRowReadingUntil(rowStatus));
  const rowSignals = rowStatus === undefined ? null : goatBotRowFaceSignals(rowStatus, now);
  const rowReading = rowSignals?.activity !== null && rowSignals?.activity !== undefined;
  const tasks = items === null ? (rowSignals?.tasks ?? null) : goatBotFaceTasks(items);
  const state = useGoatBotFaceState({
    activity: activity ?? (reading ? READING : (rowSignals?.activity ?? null)),
    waitingCount,
    shell: shell?.source ?? null,
    tasks,
  });
  const runStartedAt = (shell?.source ?? null)?.activityRunStartedAt;
  const readingSince = replyingSince ?? (rowReading ? (row?.latest?.at ?? null) : null);
  // Which work started last decides which of several working faces moves.
  const since =
    state === "reading" && readingSince !== null
      ? Date.parse(readingSince)
      : (tasks?.activeSince ??
        (runStartedAt === null || runStartedAt === undefined
          ? null
          : DateTime.toEpochMillis(runStartedAt)));
  return { state, since: since !== null && Number.isFinite(since) ? since : null };
}

const READING = { state: "reading" } as const;

/** True from when GOAT Bot starts reading a message until it answers or the limit passes. */
export function useGoatBotReading(replyingSince: string | null): boolean {
  const deadline =
    replyingSince === null ? null : Date.parse(replyingSince) + GOAT_BOT_READING_LIMIT_MS;
  const valid = deadline !== null && Number.isFinite(deadline);
  return !useDeadlinePassed(valid ? deadline : null) && valid;
}

// One page is one screen: at most one face on it moves.
const faceMotionArbiter = createFaceMotionArbiter();
let lastFaceLabel = 0;
const nextFaceLabel = () => ++lastFaceLabel;

function subscribePageVisibility(onChange: () => void) {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}
const readPageVisible = () => document.visibilityState === "visible";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
function subscribeReducedMotion(onChange: () => void) {
  const query = window.matchMedia(REDUCED_MOTION_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
const readReducedMotion = () => window.matchMedia(REDUCED_MOTION_QUERY).matches;

/**
 * Whether this face may move now, and the ref that tells it when it is on screen. A face moves
 * only while reading or working, on screen, in a visible tab, without reduced motion, and only if
 * it holds the page's one motion (header first, then the most recently started work).
 */
export function useGoatBotFaceMotion(
  state: GoatBotFaceState | undefined,
  place: { readonly rank: number; readonly since: number | null } | undefined,
): {
  readonly watch: (element: HTMLElement | null) => (() => void) | undefined;
  readonly motion: FaceMotion | null;
} {
  const [label] = useState(nextFaceLabel);
  const [onScreen, setOnScreen] = useState(false);
  // One identity for the life of the face, so re-renders never re-attach the observer.
  const watch = useStableCallback((element: HTMLElement | null) => {
    if (element === null || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      const entry = entries.at(-1);
      if (entry) setOnScreen(entry.isIntersecting);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      setOnScreen(false);
    };
  });
  const pageVisible = useSyncExternalStore(subscribePageVisibility, readPageVisible);
  const reducedMotion = useSyncExternalStore(subscribeReducedMotion, readReducedMotion);
  const eligible =
    state !== undefined &&
    place !== undefined &&
    faceMotionEligible({ state, visible: onScreen, active: pageVisible, reducedMotion });
  const rank = place?.rank ?? 0;
  const since = place?.since ?? null;
  // oxlint-disable-next-line goat/react-effect-budget -- holds this face's claim in the page's one-motion arbiter while it may move
  useEffect(() => {
    if (!eligible) return;
    faceMotionArbiter.claim(label, rank, since);
    return () => faceMotionArbiter.release(label);
  }, [eligible, label, rank, since]);
  const owner = useSyncExternalStore(faceMotionArbiter.subscribe, faceMotionArbiter.owner);
  return {
    watch,
    motion: eligible && owner === label && state !== undefined ? goatBotFaceMotion(state) : null,
  };
}
