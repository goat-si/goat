// Precedence and hold adapted from threebot web/src/lib/avatarActivity.ts (MIT, Copyright (c) 2026 Threebot contributors).
import type {
  ChannelTaskChip,
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2ThreadShell,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";

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
  /** The bot's session thread shell. */
  readonly shell: GoatBotFaceShell | null;
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
  const { shell } = input;
  if (input.waitingCount > 0 || (shell !== null && requestWaits(shell.pendingRuntimeRequest))) {
    return { state: "waiting", changesAt: null };
  }
  const completedAt = epochMs(shell?.latestRunCompletedAt);
  const messageAt = newest([
    epochMs(shell?.latestUserMessageAt),
    epochMs(shell?.latestVisibleMessage?.updatedAt),
  ]);
  if (
    shell?.status === "failed" &&
    (completedAt === null || messageAt === null || messageAt <= completedAt)
  ) {
    return { state: "failed", changesAt: null };
  }
  if (input.activity !== null) return { state: input.activity.state, changesAt: null };
  if (shell === null) return { state: "idle", changesAt: null };
  if (shell.activityRunStatus !== null && shell.activityRunStatus !== undefined) {
    return { state: "working", changesAt: null };
  }
  if (shell.status === "completed" && completedAt !== null && now >= completedAt) {
    const until = completedAt + FINISHED_MS;
    if (now < until) return { state: "finished", changesAt: until };
  }
  const lastAt = newest([completedAt, messageAt, epochMs(shell.createdAt)]);
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
  const { shell } = input;
  return JSON.stringify([
    input.activity?.state ?? null,
    input.waitingCount > 0,
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

export type GoatBotWaitingTaskItem = Pick<OrchestrationV2ProjectedTurnItem, "item">;

/** How a face draws its eyes over the goat mark's horns, on the mark's 24-unit grid. */
export interface GoatBotFaceArt {
  /** Both eyes as one path. */
  readonly eyes: string;
  /** Stroked lines rather than filled shapes. */
  readonly stroked: boolean;
  readonly sleepMark: boolean;
}

export const GOAT_BOT_FACE_STROKE_WIDTH = 1.25;
/** A small "z" above the right horn. */
export const GOAT_BOT_SLEEP_MARK_PATH = "M16.4 3.4 H19.4 L16.4 6.6 H19.4";

const EYE_X = [9.4, 14.6] as const;

function ovals(y: number, rx: number, ry: number): string {
  return EYE_X.map(
    (x) => `M${x - rx} ${y} a${rx} ${ry} 0 1 0 ${2 * rx} 0 a${rx} ${ry} 0 1 0 ${-2 * rx} 0`,
  ).join(" ");
}

function lines(y: number, bend: number): string {
  return EYE_X.map((x) => `M${x - 1.3} ${y} Q${x} ${y + bend} ${x + 1.3} ${y}`).join(" ");
}

const FACE_ART: Record<GoatBotFaceState, GoatBotFaceArt> = {
  idle: { eyes: ovals(15.3, 1.35, 1.35), stroked: false, sleepMark: false },
  reading: { eyes: ovals(16.3, 1.15, 1.15), stroked: false, sleepMark: false },
  working: { eyes: ovals(15.3, 1.5, 0.85), stroked: false, sleepMark: false },
  waiting: { eyes: ovals(14.4, 1.35, 1.35), stroked: false, sleepMark: false },
  failed: { eyes: lines(15.4, 0), stroked: true, sleepMark: false },
  finished: { eyes: lines(16, -3.4), stroked: true, sleepMark: false },
  sleeping: { eyes: lines(15, 3.2), stroked: true, sleepMark: true },
};

export function goatBotFaceArt(state: GoatBotFaceState): GoatBotFaceArt {
  return FACE_ART[state];
}

/** Tasks whose newest chip in the bot's conversation waits on the person, filtered or not. */
export function goatBotWaitingTaskCount(items: ReadonlyArray<GoatBotWaitingTaskItem>): number {
  const newestChips = new Map<string, ChannelTaskChip>();
  for (const { item } of items) {
    if (item.type !== "notification" || item.ledgerTask === undefined) continue;
    const previous = newestChips.get(item.ledgerTask.taskId);
    if (previous === undefined || item.ledgerTask.taskVersion > previous.taskVersion) {
      newestChips.set(item.ledgerTask.taskId, item.ledgerTask);
    }
  }
  let count = 0;
  for (const chip of newestChips.values()) if (chip.status === "waiting_input") count++;
  return count;
}
