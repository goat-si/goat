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

/** A main chat reads its newest sessions only; older turns show no line, like history not loaded. */
const MAIN_CHAT_SESSIONS = 2;

export type GoatBotActivitySource =
  | {
      readonly kind: "local";
      /** Newest first. */
      readonly refs: ReadonlyArray<ScopedThreadRef>;
      readonly running: boolean;
    }
  /** Work on another machine or server; null `at` trails a task's own view. */
  | { readonly kind: "elsewhere"; readonly host: string | null; readonly at: string | null };

export interface GoatBotActivityStep {
  readonly id: string;
  readonly at: string;
  readonly label: string;
  readonly state: "running" | "done" | "failed";
  readonly entry: WorkLogPresentationEntry;
}

/** One source thread's steps, from `createGoatBotActivityStepsAtoms`. */
export interface GoatBotSourceSteps {
  readonly steps: ReadonlyArray<GoatBotActivityStep>;
  /** A finished run's collapsed groups: when each started and how many items it holds. */
  readonly earlier: ReadonlyArray<{ readonly at: string; readonly count: number }>;
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
  /** Steps held in collapsed groups; 0 when none. */
  readonly earlier: number;
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
 * Which threads hold the steps a chat shows. The main chat (`taskId` null) reads the session
 * threads its turns ran on; a task's view reads the task's own worker. Only threads on the bot's
 * own server are read, since that server stamps both the conversation and the steps.
 */
export function goatBotActivitySources(input: {
  readonly visibleTurnItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
  readonly botEnvironmentId: EnvironmentId | null;
  readonly taskId: string | null;
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
    if (!here(worker)) return [{ kind: "elsewhere", host: worker.host ?? null, at: null }];
    // A session thread serves many turns, so only a task's own worker tells its whole story.
    if (isGoatBotSessionThreadId(worker.threadId)) return [];
    return [
      {
        kind: "local",
        refs: [scopeThreadRef(worker.environmentId, worker.threadId)],
        running: goatBotChipOutstanding(chip),
      },
    ];
  }
  const sessions = new Map<
    string,
    { readonly ref: ScopedThreadRef; readonly startedAt: number; readonly running: boolean }
  >();
  const elsewhere: GoatBotActivitySource[] = [];
  for (const chip of chips.values()) {
    const worker = chip.worker;
    if (worker === undefined || !isGoatBotTurn(chip)) continue;
    if (!here(worker)) {
      elsewhere.push({ kind: "elsewhere", host: worker.host ?? null, at: chip.createdAt });
      continue;
    }
    if (!isGoatBotSessionThreadId(worker.threadId)) continue;
    const previous = sessions.get(worker.threadId);
    sessions.set(worker.threadId, {
      ref: previous?.ref ?? scopeThreadRef(worker.environmentId, worker.threadId),
      startedAt: Math.max(
        previous?.startedAt ?? Number.NEGATIVE_INFINITY,
        Date.parse(chip.createdAt),
      ),
      running: (previous?.running ?? false) || goatBotChipOutstanding(chip),
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
    },
    ...elsewhere,
  ];
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
  const earlier: Array<{ readonly at: string; readonly count: number }> = [];
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
      if (at !== null) earlier.push({ at, count: row.item.deferredWork.itemCount });
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
        step.state === other.state &&
        step.label === other.label &&
        step.at === other.at
      );
    }) &&
    a.earlier.every(
      (group, index) =>
        group.at === b.earlier[index]?.at && group.count === b.earlier[index]?.count,
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
  earlier: number;
}

function activityLine(stretch: Stretch, openingId: string, live: boolean): GoatBotActivityLine {
  const steps = [...stretch.steps].sort(
    (a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id),
  );
  const done =
    steps.length === 0 ? "" : summarizeToolGroup(steps.map((step) => step.entry)).summary;
  const held =
    stretch.earlier === 0
      ? ""
      : stretch.earlier + " earlier " + (stretch.earlier === 1 ? "step" : "steps");
  return {
    key: "activity:" + (steps[0]?.id ?? "earlier:" + openingId),
    summary: done === "" ? held : held === "" ? done : done + ", plus " + held,
    failedCount: steps.filter((step) => step.state === "failed").length,
    live: live || steps.some((step) => step.state === "running"),
    steps,
    earlier: stretch.earlier,
  };
}

/**
 * Where each line goes among the rows: steps sit above the first row created at or after them,
 * and steps after the newest row trail. A stretch needs a row before it, and a source cut short by
 * the server adds nothing to a stretch that opens before its held history, so no count is partial.
 */
export function goatBotActivityPlacement(input: {
  readonly rows: ReadonlyArray<GoatBotRow>;
  readonly sources: ReadonlyArray<GoatBotActivitySource>;
  readonly steps: ReadonlyArray<GoatBotSourceSteps>;
}): GoatBotActivityPlacement {
  // A message still being sent carries this client's clock, so it never splits a stretch.
  const anchors = input.rows.filter(
    (row) => row.kind !== "day" && !(row.kind === "user" && row.sendKey !== null),
  );
  const times = anchors.map((row) => Date.parse(row.kind === "day" ? row.at : row.createdAt));
  const reach: number[] = [];
  for (const time of times) reach.push(Math.max(reach.at(-1) ?? Number.NEGATIVE_INFINITY, time));
  // The first row, in display order, created at or after the moment.
  const gapOf = (at: string) => {
    const time = Date.parse(at);
    let low = 0;
    let high = reach.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((reach[middle] ?? 0) >= time) high = middle;
      else low = middle + 1;
    }
    return low;
  };
  const stretches = new Map<number, Stretch>();
  const stretchAt = (source: GoatBotSourceSteps, at: string): Stretch | null => {
    const gap = gapOf(at);
    if (gap === 0) return null;
    const opening = times[gap - 1] ?? 0;
    if (source.heldFrom !== null && opening < Date.parse(source.heldFrom)) return null;
    let stretch = stretches.get(gap);
    if (stretch === undefined) {
      stretch = { steps: [], earlier: 0 };
      stretches.set(gap, stretch);
    }
    return stretch;
  };
  for (const source of input.steps) {
    for (const step of source.steps) stretchAt(source, step.at)?.steps.push(step);
    for (const group of source.earlier) {
      const stretch = stretchAt(source, group.at);
      if (stretch !== null) stretch.earlier += group.count;
    }
  }
  const running = input.sources.some((source) => source.kind === "local" && source.running);
  const beforeRow = new Map<string, GoatBotActivityMark>();
  let trailing: GoatBotActivityMark | null = null;
  const put = (gap: number, mark: GoatBotActivityMark) => {
    const row = anchors[gap];
    if (row === undefined) trailing ??= mark;
    else if (!beforeRow.has(row.id)) beforeRow.set(row.id, mark);
  };
  for (const [gap, stretch] of [...stretches].sort(([a], [b]) => a - b)) {
    const live = gap === anchors.length && running;
    put(gap, { kind: "steps", line: activityLine(stretch, anchors[gap - 1]?.id ?? "", live) });
  }
  for (const source of input.sources) {
    if (source.kind !== "elsewhere") continue;
    const gap = source.at === null ? anchors.length : gapOf(source.at);
    if (source.at !== null && gap === 0) continue;
    put(gap, { kind: "elsewhere", host: source.host });
  }
  return beforeRow.size === 0 && trailing === null ? NO_MARKS : { beforeRow, trailing };
}
