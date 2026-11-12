// Precedence and hold adapted from threebot web/src/lib/avatarActivity.ts (MIT, Copyright (c) 2026 Threebot contributors).
import type {
  ChannelTaskChip,
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2ThreadShell,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";

import { goatBotTaskWaitsOnPerson } from "./activity.ts";
import { GOAT_BOT_READING_LIMIT_MS } from "./rows.ts";

/** What a bot's face shows. Each is a still drawing; a change fades once at most. */
export type GoatBotFaceState =
  | "idle"
  | "reading"
  | "working"
  | "waiting"
  | "failed"
  | "finished"
  | "sleeping";

/** Only the session shell fields the face reads; every client already holds them. */
export type GoatBotFaceShell = Pick<
  OrchestrationV2ThreadShell,
  | "activityRunStatus"
  | "latestRunStartHeld"
  | "pendingRuntimeRequest"
  | "latestRunCompletedAt"
  | "status"
  | "latestVisibleMessage"
  | "latestUserMessageAt"
  | "createdAt"
>;

export interface GoatBotFaceInput {
  /** goatBotActivity() for the open conversation; null elsewhere. */
  readonly activity: { readonly state: "reading" | "working" } | null;
  /** Tasks waiting on the person for this bot; 0 when the caller cannot know. */
  readonly waitingCount: number;
  /** The bot's conversation thread shell. */
  readonly shell: GoatBotFaceShell | null;
  /** goatBotFaceTasks() over the conversation when the client holds it; null otherwise. */
  readonly tasks: GoatBotFaceTasks | null;
}

/** The wanted face and when it can change with no new data. */
export interface GoatBotFace {
  readonly state: GoatBotFaceState;
  readonly changesAt: number | null;
}

export const FACE_HOLD_MS = 1_200;
export const FINISHED_MS = 4_000;
export const SLEEP_AFTER_MS = 2 * 60 * 60_000;

/** These skip the hold: the person should see them now. */
const URGENT: ReadonlySet<GoatBotFaceState> = new Set(["waiting", "failed"]);

const FACE_LABEL: Record<GoatBotFaceState, string | null> = {
  idle: null,
  reading: "Reading",
  working: "Working",
  waiting: "Waiting for you",
  failed: "Last run failed",
  finished: "Finished",
  sleeping: "Sleeping",
};

/** What the face says to assistive technology; null when it only decorates. */
export function goatBotFaceLabel(state: GoatBotFaceState): string | null {
  return FACE_LABEL[state];
}

/**
 * The face's label where a row also counts what waits on the person, so waiting is said once and
 * with its count. A count means the face waits, since waiting beats every other face.
 */
export function goatBotFaceSpoken(state: GoatBotFaceState, waitingCount: number): string | null {
  return waitingCount > 0 ? `${waitingCount} waiting for you` : goatBotFaceLabel(state);
}

/** The parts of a bot's status (channel.getBotStatus) a roster row reads. */
export interface GoatBotRowStatus {
  readonly waitingCount: number;
  readonly latest?: { readonly at: string; readonly author: "bot" | "person" } | undefined;
  /** Whether one of the bot's tasks is going; absent from servers that do not say. */
  readonly tasks?: { readonly active: boolean } | undefined;
}

export interface GoatBotRowFaceSignals extends Omit<GoatBotFaceInput, "shell"> {
  /** When reading ends with no newer status; null when the bot's message is the newest. */
  readonly readingUntil: number | null;
}

const READING = { state: "reading" } as const;

/** When a row's reading ends: the person's newest message plus the reading limit; null otherwise. */
export function goatBotRowReadingUntil(status: GoatBotRowStatus): number | null {
  if (status.latest?.author !== "person") return null;
  const until = Date.parse(status.latest.at) + GOAT_BOT_READING_LIMIT_MS;
  return Number.isFinite(until) ? until : null;
}

/**
 * A roster row's face inputs from its bot status alone, with no conversation loaded. The bot is
 * reading while the person's message is the newest one, until the reading limit; without the
 * status's tasks they are unknown, as the conversation shell alone shows them.
 */
export function goatBotRowFaceSignals(
  status: GoatBotRowStatus,
  now: number,
): GoatBotRowFaceSignals {
  const readingUntil = goatBotRowReadingUntil(status);
  return {
    activity: readingUntil !== null && now < readingUntil ? READING : null,
    waitingCount: status.waitingCount,
    tasks:
      status.tasks === undefined
        ? null
        : { waiting: 0, active: status.tasks.active ? 1 : 0, ended: null, activeSince: null },
    readingUntil,
  };
}

function epochMs(value: DateTime.Utc | null | undefined): number | null {
  return value === null || value === undefined ? null : DateTime.toEpochMillis(value);
}

function newest(values: ReadonlyArray<number | null>): number | null {
  let result: number | null = null;
  for (const value of values)
    if (value !== null && (result === null || value > result)) result = value;
  return result;
}

function earliestAfter(now: number, values: ReadonlyArray<number | null>): number | null {
  let result: number | null = null;
  for (const value of values) {
    if (value !== null && value > now && (result === null || value < result)) result = value;
  }
  return result;
}

/** A pending request stops the bot unless the run keeps working past it, as activity.ts reads it. */
function requestWaits(request: GoatBotFaceShell["pendingRuntimeRequest"]): boolean {
  return request !== null && request.blocking !== false && request.kind !== "dynamic_tool_call";
}

/** The face the data asks for; waiting > failed > reading > working > finished > sleeping > idle. */
export function goatBotFace(input: GoatBotFaceInput, now: number): GoatBotFace {
  const { shell, tasks } = input;
  if (
    input.waitingCount > 0 ||
    (shell?.activityRunStatus === "starting" && shell.latestRunStartHeld === true) ||
    (tasks !== null && tasks.waiting > 0) ||
    (shell !== null && requestWaits(shell.pendingRuntimeRequest))
  ) {
    return { state: "waiting", changesAt: null };
  }
  const completedAt = epochMs(shell?.latestRunCompletedAt);
  const userAt = epochMs(shell?.latestUserMessageAt);
  const messageAt = newest([userAt, epochMs(shell?.latestVisibleMessage?.updatedAt)]);
  const ended = tasks?.ended ?? null;
  if (
    (shell?.status === "failed" &&
      (completedAt === null || messageAt === null || messageAt <= completedAt)) ||
    (ended?.status === "failed" && (userAt === null || userAt <= ended.at))
  ) {
    return { state: "failed", changesAt: null };
  }
  if (input.activity !== null) return { state: input.activity.state, changesAt: null };
  if (
    (tasks !== null && tasks.active > 0) ||
    (shell?.activityRunStatus !== null && shell?.activityRunStatus !== undefined)
  ) {
    return { state: "working", changesAt: null };
  }
  const finishedAt = newest([
    shell?.status === "completed" ? completedAt : null,
    ended?.status === "completed" ? ended.at : null,
  ]);
  if (finishedAt !== null && now >= finishedAt && now < finishedAt + FINISHED_MS) {
    return { state: "finished", changesAt: finishedAt + FINISHED_MS };
  }
  const lastAt = newest([completedAt, messageAt, ended?.at ?? null, epochMs(shell?.createdAt)]);
  if (lastAt === null) return { state: "idle", changesAt: null };
  const sleepAt = lastAt + SLEEP_AFTER_MS;
  return now >= sleepAt
    ? { state: "sleeping", changesAt: null }
    : { state: "idle", changesAt: sleepAt };
}

/** What is on screen and until when it must stay. */
export interface FaceHold {
  readonly shown: GoatBotFaceState;
  readonly lockedUntil: number;
}

/**
 * Moves the shown face toward the wanted one. A face stays FACE_HOLD_MS, so a fast A, B, A
 * never leaves A; waiting and failed skip the hold. The first face shows at once.
 */
export function faceHoldStep(
  previous: FaceHold | null,
  wanted: GoatBotFaceState,
  now: number,
): FaceHold {
  if (previous === null) return { shown: wanted, lockedUntil: now };
  if (previous.shown === wanted) return previous;
  if (!URGENT.has(wanted) && now < previous.lockedUntil) return previous;
  return { shown: wanted, lockedUntil: now + FACE_HOLD_MS };
}

/** A face over time: the input it last read, what it shows, and the next time it may change. */
export interface GoatBotFaceTrack {
  readonly key: string;
  readonly hold: FaceHold;
  /** Strictly after the step's now, or null. */
  readonly wakeAt: number | null;
}

/** Changes whenever goatBotFace could answer differently for the same clock. */
export function goatBotFaceKey(input: GoatBotFaceInput): string {
  const { shell, tasks } = input;
  return JSON.stringify([
    input.activity?.state ?? null,
    input.waitingCount > 0,
    tasks === null
      ? null
      : [tasks.waiting > 0, tasks.active > 0, tasks.ended?.status ?? null, tasks.ended?.at ?? null],
    shell === null
      ? null
      : [
          shell.activityRunStatus ?? null,
          requestWaits(shell.pendingRuntimeRequest),
          shell.status,
          epochMs(shell.latestRunCompletedAt),
          epochMs(shell.latestUserMessageAt),
          epochMs(shell.latestVisibleMessage?.updatedAt),
          epochMs(shell.createdAt),
        ],
  ]);
}

export function advanceGoatBotFace(
  previous: GoatBotFaceTrack | null,
  input: GoatBotFaceInput,
  now: number,
): GoatBotFaceTrack {
  const face = goatBotFace(input, now);
  const hold = faceHoldStep(previous?.hold ?? null, face.state, now);
  const holdEnds = hold.shown === face.state ? null : hold.lockedUntil;
  return {
    key: goatBotFaceKey(input),
    hold,
    wakeAt: earliestAfter(now, [face.changesAt, holdEnds]),
  };
}

export type GoatBotFaceTaskItem = Pick<OrchestrationV2ProjectedTurnItem, "item">;

/** What the bot's work in its conversation says, from the task chips the conversation holds. */
export interface GoatBotFaceTasks {
  readonly waiting: number;
  readonly active: number;
  /** The newest task that ended, when no task is still going. */
  readonly ended: {
    readonly status: "completed" | "failed" | "cancelled";
    readonly at: number;
  } | null;
  /** When the newest still-going task started; decides which working face moves first. */
  readonly activeSince: number | null;
}

/**
 * The bot's turns and work, read from the newest chip of each task in its conversation whether or
 * not a roster shows it. GOAT Bot runs in per-task session threads, so its conversation thread's
 * own shell never runs; these chips are where its work shows.
 */
export function goatBotFaceTasks(items: ReadonlyArray<GoatBotFaceTaskItem>): GoatBotFaceTasks {
  const newestChips = new Map<string, ChannelTaskChip>();
  for (const { item } of items) {
    if (item.type !== "notification" || item.ledgerTask === undefined) continue;
    const previous = newestChips.get(item.ledgerTask.taskId);
    if (previous === undefined || item.ledgerTask.taskVersion > previous.taskVersion) {
      newestChips.set(item.ledgerTask.taskId, item.ledgerTask);
    }
  }
  let waiting = 0;
  let active = 0;
  let ended: GoatBotFaceTasks["ended"] = null;
  let activeSince: number | null = null;
  for (const chip of newestChips.values()) {
    const status = chip.status;
    const going = status === "received" || status === "dispatching" || status === "running";
    const approvalLeft =
      (status === "completed" || status === "failed") &&
      chip.observed?.needsYou.some((item) => item.kind === "approval") === true;
    // A running turn whose coding thread asks something waits on the person too.
    if (status === "waiting_input" || approvalLeft || (going && goatBotTaskWaitsOnPerson(chip)))
      waiting++;
    else if (going) {
      active++;
      const since = Date.parse(chip.createdAt);
      if (Number.isFinite(since) && (activeSince === null || since > activeSince)) {
        activeSince = since;
      }
    } else {
      const at = Date.parse(chip.updatedAt);
      if (Number.isFinite(at) && (ended === null || at > ended.at)) {
        ended = { status, at };
      }
    }
  }
  return { waiting, active, ended: waiting > 0 || active > 0 ? null : ended, activeSince };
}
