import { scopeThreadRef } from "@goat/client-runtime/environment";
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
  type FaceMotion,
  type GoatBotFaceInput,
  type GoatBotFaceState,
} from "@goat/client-runtime/goatBot";
import type { EnvironmentId, ThreadId } from "@goat/contracts";
import { useIsFocused } from "@react-navigation/native";
import * as DateTime from "effect/DateTime";
import { useEffect, useState, useSyncExternalStore } from "react";

import { useAppActive, useReduceMotionEnabled } from "../../lib/appState";
import { useDeadlinePassed } from "../../lib/clock";
import { useThreadShell } from "../../state/entities";
import { useThreadVisibleTurnItems } from "../../state/use-thread-detail";
import { useMobileGoatBotHomeMode } from "./useMobileGoatBotHomeMode";

/**
 * A bot's face, from its conversation shell and the task chips in its conversation, which the
 * roster and chat already hold: the main bot's unless a member's conversation is given. Mobile has
 * no waiting badge, so every waiting chip counts.
 */
export function useMobileGoatBotFace(
  activity: GoatBotFaceInput["activity"],
  conversation?: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId } | null,
): {
  readonly state: GoatBotFaceState;
  readonly since: number | null;
} {
  const home = useMobileGoatBotHomeMode();
  const botRef = conversation === undefined ? home.botRef : conversation;
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
  const tasks = goatBotFaceTasks(items);
  const input: GoatBotFaceInput = {
    activity: activity ?? (reading ? READING : null),
    waitingCount: 0,
    shell: shell?.source ?? null,
    tasks,
  };
  const key = goatBotFaceKey(input);
  // The clock is read inside the updaters so a restarted render gets the current time.
  const [track, setTrack] = useState(() => firstFaceTrack(input));
  const due = useDeadlinePassed(track.wakeAt);
  if (track.key !== key || due) {
    setTrack((previous) => advanceGoatBotFace(previous, input, Date.now()));
  }
  const state = track.hold.shown;
  const runStartedAt = (shell?.source ?? null)?.activityRunStartedAt;
  // Which work started last decides which of several working faces moves.
  const since =
    state === "reading" && replyingSince !== null
      ? Date.parse(replyingSince)
      : (tasks.activeSince ??
        (runStartedAt === null || runStartedAt === undefined
          ? null
          : DateTime.toEpochMillis(runStartedAt)));
  return { state, since: since !== null && Number.isFinite(since) ? since : null };
}

const READING = { state: "reading" } as const;

function firstFaceTrack(input: GoatBotFaceInput) {
  return advanceGoatBotFace(null, input, Date.now());
}

// Screens that are mounted but not focused never claim, so one arbiter serves the app.
const faceMotionArbiter = createFaceMotionArbiter();
let lastFaceLabel = 0;
const nextFaceLabel = () => ++lastFaceLabel;

/**
 * The eye motion this face runs now, or null. It moves only while reading or working, on screen,
 * on the focused screen, with the app active and Reduce Motion off, and only if it holds the one
 * motion (chat header first, then the most recently started work).
 */
export function useMobileGoatBotFaceMotion(
  state: GoatBotFaceState,
  rank: number,
  since: number | null,
  onScreen: boolean,
): FaceMotion | null {
  const active = useAppActive();
  const reducedMotion = useReduceMotionEnabled();
  const focused = useIsFocused();
  const [label] = useState(nextFaceLabel);
  const eligible = faceMotionEligible({
    state,
    visible: onScreen && focused,
    active,
    reducedMotion,
  });
  // oxlint-disable-next-line goat/react-effect-budget -- holds this face's claim in the app's one-motion arbiter while it may move
  useEffect(() => {
    if (!eligible) return;
    faceMotionArbiter.claim(label, rank, since);
    return () => faceMotionArbiter.release(label);
  }, [eligible, label, rank, since]);
  const owner = useSyncExternalStore(faceMotionArbiter.subscribe, faceMotionArbiter.owner);
  return eligible && owner === label ? goatBotFaceMotion(state) : null;
}
