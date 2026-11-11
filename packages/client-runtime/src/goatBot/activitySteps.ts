import {
  EnvironmentId,
  isGoatBotSessionThreadId,
  ThreadId,
  type ChannelTaskChip,
  type ChannelWorkerRef,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
  type ScopedThreadRef,
} from "@goat/contracts";
import {
  resolveGoatMcpItemCall,
  resolveGoatMcpShippedToolId,
} from "@goat/shared/goatMcpToolPresentation";
import { dynamicToolTitle } from "@goat/shared/toolActivity";
import * as DateTime from "effect/DateTime";
import { Atom } from "effect/reactivity";

import { scopeThreadRef } from "../environment/scoped.ts";
import type { ThreadStructureVisibleTurnItem } from "../state/models.ts";
import { commandDisplayText } from "../work-log/commandLabel.ts";
import {
  commandVerb,
  formatCommandActionsLabel,
  liveActivityToolStatus,
  resolveWorkEntryToolPresentation,
  summarizeToolGroup,
  workEntryCommandActions,
  workEntryDisplayIndicatesToolFailure,
  type WorkLogPresentationEntry,
} from "../work-log/presentation.ts";
import { turnItemWorkLogEntry } from "../work-log/turnItemEntry.ts";
import { goatBotChipOutstanding } from "./activity.ts";
import { isGoatBotTurn } from "./readers.ts";
import type { GoatBotRow } from "./rows.ts";

/**
 * GOAT Bot's activity lines: what the bot did between two messages, counted on one quiet line
 * that opens to the steps. Steps come from the session threads the main chat's turns ran on, or
 * from a task's own worker in its view. The bot thread itself holds no tool calls.
 */

/**
 * A main chat reads its newest session only: every opening of a bot chat pays for its snapshot,
 * so older turns on other sessions show no line, like history not loaded.
 */
const MAIN_CHAT_SESSIONS = 1;

/** The turn a session run serves, from the turn's chip. */
export interface GoatBotRunTurn {
  readonly taskId: string;
  /** When the turn began; its first stretch opens here. */
  readonly since: string;
  readonly running: boolean;
}

export type GoatBotActivitySource =
  | {
      readonly kind: "local";
      /** Newest first. */
      readonly refs: ReadonlyArray<ScopedThreadRef>;
      readonly running: boolean;
      /**
       * In the main chat, the turn each run serves by run id; a step of any other run gets no line.
       * Null in a task's view, where every step is that task's.
       */
      readonly runs: ReadonlyMap<string, GoatBotRunTurn> | null;
    }
  /** Work on another machine or server; null `at` trails a task's own view. */
  | {
      readonly kind: "elsewhere";
      readonly host: string | null;
      readonly at: string | null;
      /** The main chat's turn it ran for; null in a task's view. */
      readonly turn: GoatBotRunTurn | null;
    };

export interface GoatBotActivityStep {
  readonly id: string;
  /** The run that took the step; null when the server did not say. */
  readonly runId: string | null;
  readonly at: string;
  readonly label: string;
  readonly state: "running" | "done" | "failed";
  readonly entry: WorkLogPresentationEntry;
}

/** One source thread's steps, from `createGoatBotActivityStepsAtoms`. */
export interface GoatBotSourceSteps {
  readonly steps: ReadonlyArray<GoatBotActivityStep>;
  /**
   * A finished run's collapsed groups, by when each started. Their counts include reasoning and
   * their steps are not loaded, so a line names them without a number.
   */
  readonly earlier: ReadonlyArray<{ readonly at: string; readonly runId: string | null }>;
  /** Where the held history starts when the server sent only its newest part; null when whole. */
  readonly heldFrom: string | null;
}

export interface GoatBotActivityLine {
  /** Stays the same while its stretch grows. */
  readonly key: string;
  readonly summary: string;
  readonly failedCount: number;
  readonly live: boolean;
  readonly steps: ReadonlyArray<GoatBotActivityStep>;
  /** Whether collapsed earlier work, not listed, belongs to this stretch. */
  readonly earlier: boolean;
}

export type GoatBotActivityMark =
  | { readonly kind: "steps"; readonly line: GoatBotActivityLine }
  | { readonly kind: "elsewhere"; readonly host: string | null };

export interface GoatBotActivityPlacement {
  /** By row id: the mark shown directly above that row. */
  readonly beforeRow: ReadonlyMap<string, GoatBotActivityMark>;
  /** The mark after the newest row, above the live status line. */
  readonly trailing: GoatBotActivityMark | null;
}

export const EMPTY_GOAT_BOT_SOURCE_STEPS: GoatBotSourceSteps = {
  steps: [],
  earlier: [],
  heldFrom: null,
};

const NO_MARKS: GoatBotActivityPlacement = {
  beforeRow: new Map(),
  trailing: null,
};

function newestChips(
  visibleTurnItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
): ReadonlyMap<string, ChannelTaskChip> {
  const chips = new Map<string, ChannelTaskChip>();
  for (const { item } of visibleTurnItems) {
    if (item.type !== "notification" || item.ledgerTask === undefined) continue;
    const previous = chips.get(item.ledgerTask.taskId);
    if (previous === undefined || item.ledgerTask.taskVersion > previous.taskVersion) {
      chips.set(item.ledgerTask.taskId, item.ledgerTask);
    }
  }
  return chips;
}

/**
 * Which threads hold the steps a chat shows: the main chat's newest turn session, or a task's own
 * worker. Only the bot's own server is read, since it stamps both the conversation and the steps,
 * and only when it sends a thread's newest part (`boundedSnapshots`); otherwise opening one fetches
 * its whole history.
 */
export function goatBotActivitySources(input: {
  readonly visibleTurnItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
  readonly botEnvironmentId: EnvironmentId | null;
  readonly taskId: string | null;
  readonly boundedSnapshots: boolean;
}): ReadonlyArray<GoatBotActivitySource> {
  const { botEnvironmentId } = input;
  if (botEnvironmentId === null) return [];
  const chips = newestChips(input.visibleTurnItems);
  const here = (worker: ChannelWorkerRef) =>
    worker.host === undefined && worker.environmentId === botEnvironmentId;
  if (input.taskId !== null) {
    const chip = chips.get(input.taskId);
    const worker = chip?.worker;
    if (chip === undefined || worker === undefined) return [];
    if (!here(worker))
      return [{ kind: "elsewhere", host: worker.host ?? null, at: null, turn: null }];
    // A session thread serves many turns, so only a task's own worker tells its whole story.
    if (isGoatBotSessionThreadId(worker.threadId) || !input.boundedSnapshots) return [];
    return [
      {
        kind: "local",
        refs: [scopeThreadRef(worker.environmentId, worker.threadId)],
        running: goatBotChipOutstanding(chip),
        runs: null,
      },
    ];
  }
  const sessions = new Map<
    string,
    {
      readonly ref: ScopedThreadRef;
      readonly startedAt: number;
      readonly running: boolean;
      readonly runs: Map<string, GoatBotRunTurn>;
    }
  >();
  const elsewhere: GoatBotActivitySource[] = [];
  for (const chip of chips.values()) {
    const worker = chip.worker;
    if (worker === undefined || !isGoatBotTurn(chip)) continue;
    const turn: GoatBotRunTurn = {
      taskId: chip.taskId,
      since: chip.createdAt,
      running: goatBotChipOutstanding(chip),
    };
    if (!here(worker)) {
      elsewhere.push({ kind: "elsewhere", host: worker.host ?? null, at: chip.createdAt, turn });
      continue;
    }
    if (!isGoatBotSessionThreadId(worker.threadId) || !input.boundedSnapshots) continue;
    const previous = sessions.get(worker.threadId);
    const runs = previous?.runs ?? new Map<string, GoatBotRunTurn>();
    // The chip names its turn's current run only, so a turn's earlier runs show no line.
    if (worker.runId !== undefined) runs.set(worker.runId, turn);
    sessions.set(worker.threadId, {
      ref: previous?.ref ?? scopeThreadRef(worker.environmentId, worker.threadId),
      startedAt: Math.max(
        previous?.startedAt ?? Number.NEGATIVE_INFINITY,
        Date.parse(chip.createdAt),
      ),
      running: (previous?.running ?? false) || turn.running,
      runs,
    });
  }
  const kept = [...sessions.values()]
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, MAIN_CHAT_SESSIONS);
  if (kept.length === 0) return elsewhere;
  return [
    {
      kind: "local",
      refs: kept.map((session) => session.ref),
      running: kept.some((session) => session.running),
      runs: new Map(kept.flatMap((session) => [...session.runs])),
    },
    ...elsewhere,
  ];
}

/** The turn each of GOAT Bot's replies and questions answers for, by row id. */
export function goatBotActivityRowTurns(
  visibleTurnItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
): ReadonlyMap<string, string> {
  const turns = new Map<string, string>();
  for (const { item } of visibleTurnItems) {
    if (item.type === "assistant_message" && item.channel?.taskId !== undefined)
      turns.set(item.id, item.channel.taskId);
  }
  return turns;
}

const STEP_TYPES: ReadonlySet<OrchestrationV2TurnItem["type"]> = new Set([
  "command_execution",
  "file_change",
  "file_search",
  "web_search",
  "dynamic_tool",
  "subagent",
  "thread_created",
]);

/** The run's report to GOAT Bot, which the reply itself shows. */
const REPORT_TOOLS: ReadonlySet<string> = new Set([
  "goat_thread_report_result",
  "channel_task_report",
]);

const isReportCall = (item: OrchestrationV2TurnItem) =>
  item.type === "dynamic_tool" &&
  REPORT_TOOLS.has(resolveGoatMcpShippedToolId(resolveGoatMcpItemCall(item).toolName) ?? "");

/** The step's line, as a coding thread's work row reads it. */
function stepLabel(entry: WorkLogPresentationEntry): string {
  const presentation = resolveWorkEntryToolPresentation(entry);
  if (presentation) return presentation.displayName;
  const actions = workEntryCommandActions(entry);
  if (actions) return formatCommandActionsLabel(actions);
  if (entry.command?.trim()) {
    const verb = commandVerb(liveActivityToolStatus(entry.toolLifecycleStatus, false));
    return verb + " " + commandDisplayText(entry.command);
  }
  const item = entry.structuredPayload;
  return (
    (item?.type === "dynamic_tool"
      ? dynamicToolTitle(item.toolName, item.input, item.title)
      : undefined) ?? entry.label
  );
}

// Unchanged items keep their identity across updates, so each is read once.
const stepsByItem = new WeakMap<object, GoatBotActivityStep | null>();

function stepOf(row: OrchestrationV2ProjectedTurnItem): GoatBotActivityStep | null {
  const cached = stepsByItem.get(row.item);
  if (cached !== undefined) return cached;
  const step =
    !STEP_TYPES.has(row.item.type) || isReportCall(row.item)
      ? null
      : (() => {
          const entry = turnItemWorkLogEntry(row);
          return {
            id: row.item.id,
            runId: row.item.runId,
            at: entry.createdAt,
            label: stepLabel(entry),
            state:
              entry.toolLifecycleStatus === "inProgress"
                ? ("running" as const)
                : workEntryDisplayIndicatesToolFailure(entry)
                  ? ("failed" as const)
                  : ("done" as const),
            entry,
          };
        })();
  stepsByItem.set(row.item, step);
  return step;
}

// Streamed items lose their updatedAt in the thread's structure; startedAt still places them.
const itemAt = (item: ThreadStructureVisibleTurnItem["item"]) => {
  const at = item.startedAt ?? ("updatedAt" in item ? item.updatedAt : undefined);
  return at === undefined || at === null ? null : DateTime.formatIso(at);
};

const isStepRow = (row: ThreadStructureVisibleTurnItem): row is OrchestrationV2ProjectedTurnItem =>
  STEP_TYPES.has(row.item.type);

/** A source thread's steps in time order, with its collapsed groups and where its history starts. */
export function goatBotSourceSteps(
  rows: ReadonlyArray<ThreadStructureVisibleTurnItem>,
  hasMoreHistory: boolean,
): GoatBotSourceSteps {
  const steps: GoatBotActivityStep[] = [];
  const earlier: Array<{ readonly at: string; readonly runId: string | null }> = [];
  let heldFrom: string | null = null;
  for (const row of rows) {
    const at = itemAt(row.item);
    if (
      hasMoreHistory &&
      at !== null &&
      (heldFrom === null || Date.parse(at) < Date.parse(heldFrom))
    )
      heldFrom = at;
    // A collapsed group's anchor may be any item, reasoning included; it stands for the group.
    if (row.item.deferredWork !== undefined) {
      if (at !== null) earlier.push({ at, runId: row.item.runId });
      continue;
    }
    const step = isStepRow(row) ? stepOf(row) : null;
    if (step !== null) steps.push(step);
  }
  steps.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return { steps, earlier, heldFrom };
}

function sameSourceSteps(a: GoatBotSourceSteps, b: GoatBotSourceSteps): boolean {
  return (
    a.heldFrom === b.heldFrom &&
    a.steps.length === b.steps.length &&
    a.earlier.length === b.earlier.length &&
    a.steps.every((step, index) => {
      const other = b.steps[index];
      return (
        other !== undefined &&
        step.id === other.id &&
        step.runId === other.runId &&
        step.state === other.state &&
        step.label === other.label &&
        step.at === other.at
      );
    }) &&
    a.earlier.every(
      (group, index) =>
        group.at === b.earlier[index]?.at && group.runId === b.earlier[index]?.runId,
    )
  );
}

/**
 * One atom per source thread. It reads the thread's quiet items, which hold through streamed
 * assistant and reasoning text, and keeps its value while no step's id, state, label or time moved.
 */
export function createGoatBotActivityStepsAtoms(details: {
  readonly quietVisibleTurnItemsAtom: (
    ref: ScopedThreadRef,
  ) => Atom.Atom<ReadonlyArray<ThreadStructureVisibleTurnItem>>;
  readonly historyAtom: (ref: ScopedThreadRef) => Atom.Atom<{ readonly hasMoreHistory: boolean }>;
}) {
  const stepsAtomFamily = Atom.family((key: string) => {
    const separator = key.indexOf("\u0000");
    const ref = scopeThreadRef(
      EnvironmentId.make(key.slice(0, separator)),
      ThreadId.make(key.slice(separator + 1)),
    );
    let previous = EMPTY_GOAT_BOT_SOURCE_STEPS;
    return Atom.make((get) => {
      const next = goatBotSourceSteps(
        get(details.quietVisibleTurnItemsAtom(ref)),
        get(details.historyAtom(ref)).hasMoreHistory,
      );
      if (!sameSourceSteps(previous, next)) previous = next;
      return previous;
    }).pipe(Atom.setIdleTTL(0), Atom.withLabel("goat-bot-activity-steps:" + key));
  });
  return {
    stepsAtom: (ref: ScopedThreadRef) =>
      stepsAtomFamily(ref.environmentId + "\u0000" + ref.threadId),
  };
}

interface Stretch {
  readonly steps: GoatBotActivityStep[];
  earlier: boolean;
}

function activityLine(stretch: Stretch, openingId: string, live: boolean): GoatBotActivityLine {
  const steps = [...stretch.steps].sort(
    (a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id),
  );
  const done =
    steps.length === 0 ? "" : summarizeToolGroup(steps.map((step) => step.entry)).summary;
  return {
    key: "activity:" + (steps[0]?.id ?? "earlier:" + openingId),
    summary: !stretch.earlier ? done : done === "" ? "Earlier work" : done + ", plus earlier work",
    failedCount: steps.filter((step) => step.state === "failed").length,
    live: live || steps.some((step) => step.state === "running"),
    steps,
    earlier: stretch.earlier,
  };
}

interface TimedRows {
  /** Display positions among the anchors. */
  readonly indexes: number[];
  readonly times: number[];
  /** The latest time so far at each position, so a row that sorts out of order still splits. */
  readonly reach: number[];
}

function addRow(rows: TimedRows, index: number, time: number) {
  rows.indexes.push(index);
  rows.times.push(time);
  rows.reach.push(Math.max(rows.reach.at(-1) ?? Number.NEGATIVE_INFINITY, time));
}

/** The first of the rows, in display order, created at or after the moment. */
function firstAtOrAfter(rows: TimedRows, time: number): number {
  let low = 0;
  let high = rows.reach.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((rows.reach[middle] ?? 0) >= time) high = middle;
    else low = middle + 1;
  }
  return low;
}

/**
 * Where each line goes. A main-chat step sits above the first reply or question at or after it of
 * the turn its run serves, trails only while that turn runs, and gets no line for a run no turn
 * names. In a task's view every step is the task's and sits above the first row after it. No
 * stretch opens before the source's held history, so no count is partial.
 */
export function goatBotActivityPlacement(input: {
  readonly rows: ReadonlyArray<GoatBotRow>;
  readonly sources: ReadonlyArray<GoatBotActivitySource>;
  readonly steps: ReadonlyArray<GoatBotSourceSteps>;
  /** From `goatBotActivityRowTurns`. */
  readonly rowTurns: ReadonlyMap<string, string>;
}): GoatBotActivityPlacement {
  // A message still being sent carries this client's clock, so it never splits a stretch.
  const anchors = input.rows.filter(
    (row) => row.kind !== "day" && !(row.kind === "user" && row.sendKey !== null),
  );
  const all: TimedRows = { indexes: [], times: [], reach: [] };
  const turnRows = new Map<string, TimedRows>();
  anchors.forEach((row, index) => {
    const time = Date.parse(row.kind === "day" ? row.at : row.createdAt);
    addRow(all, index, time);
    const taskId = row.kind === "bot" ? input.rowTurns.get(row.id) : undefined;
    if (taskId === undefined) return;
    let rows = turnRows.get(taskId);
    if (rows === undefined) {
      rows = { indexes: [], times: [], reach: [] };
      turnRows.set(taskId, rows);
    }
    addRow(rows, index, time);
  });
  const opensBefore = (heldFrom: string | null, opening: number) =>
    heldFrom !== null && opening < Date.parse(heldFrom);
  const byTime = (heldFrom: string | null, at: string): number | null => {
    const gap = firstAtOrAfter(all, Date.parse(at));
    if (gap === 0 || opensBefore(heldFrom, all.times[gap - 1] ?? 0)) return null;
    return gap;
  };
  const byTurn = (turn: GoatBotRunTurn, heldFrom: string | null, at: string): number | null => {
    const rows = turnRows.get(turn.taskId) ?? { indexes: [], times: [], reach: [] };
    const next = firstAtOrAfter(rows, Date.parse(at));
    const opening = next === 0 ? Date.parse(turn.since) : (rows.times[next - 1] ?? 0);
    if (opensBefore(heldFrom, opening)) return null;
    const index = rows.indexes[next];
    if (index !== undefined) return index;
    return turn.running ? anchors.length : null;
  };
  const local = input.sources.find((source) => source.kind === "local");
  const runs = local?.kind === "local" ? local.runs : null;
  const gapOf = (source: GoatBotSourceSteps, runId: string | null, at: string) => {
    if (runs === null) return byTime(source.heldFrom, at);
    const turn = runId === null ? undefined : runs.get(runId);
    return turn === undefined ? null : byTurn(turn, source.heldFrom, at);
  };
  const stretches = new Map<number, Stretch>();
  const stretchAt = (gap: number): Stretch => {
    let stretch = stretches.get(gap);
    if (stretch === undefined) {
      stretch = { steps: [], earlier: false };
      stretches.set(gap, stretch);
    }
    return stretch;
  };
  for (const source of input.steps) {
    for (const step of source.steps) {
      const gap = gapOf(source, step.runId, step.at);
      if (gap !== null) stretchAt(gap).steps.push(step);
    }
    for (const group of source.earlier) {
      const gap = gapOf(source, group.runId, group.at);
      if (gap !== null) stretchAt(gap).earlier = true;
    }
  }
  const running = local?.kind === "local" && local.running;
  const beforeRow = new Map<string, GoatBotActivityMark>();
  let trailing: GoatBotActivityMark | null = null;
  const put = (gap: number, mark: GoatBotActivityMark) => {
    const row = anchors[gap];
    if (row === undefined) trailing ??= mark;
    else if (!beforeRow.has(row.id)) beforeRow.set(row.id, mark);
  };
  for (const [gap, stretch] of [...stretches].sort(([a], [b]) => a - b)) {
    const live = gap === anchors.length && running;
    const opening = anchors[gap]?.id ?? "end";
    put(gap, { kind: "steps", line: activityLine(stretch, opening, live) });
  }
  for (const source of input.sources) {
    if (source.kind !== "elsewhere") continue;
    const gap =
      source.at === null
        ? anchors.length
        : source.turn === null
          ? byTime(null, source.at)
          : byTurn(source.turn, null, source.at);
    if (gap !== null) put(gap, { kind: "elsewhere", host: source.host });
  }
  return beforeRow.size === 0 && trailing === null ? NO_MARKS : { beforeRow, trailing };
}
