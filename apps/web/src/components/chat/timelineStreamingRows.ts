import { shallow } from "zustand/vanilla/shallow";
import {
  isStreamingMessageTextUpdate,
  isStreamingTurnItemTextUpdate,
  type TimelineEntry,
  type WorkLogEntry,
} from "../../session-logic";
import type { ChatMessage, ProposedPlan } from "../../types";
import type {
  MessagesTimelineRow,
  MessagesTimelineRowsInput,
  MessagesTimelineRowsProjection,
} from "./MessagesTimeline.logic";

function sameCheckpointSummaries(
  previous: MessagesTimelineRowsInput["turnDiffSummaries"],
  next: MessagesTimelineRowsInput["turnDiffSummaries"],
): boolean {
  if (previous === next) return true;
  if (previous.length !== next.length) return false;
  for (const [index, summary] of previous.entries()) {
    if (!shallow(summary, next[index])) return false;
  }
  return true;
}

export function replaceStreamingMessageRows(
  input: MessagesTimelineRowsInput,
  previous: MessagesTimelineRowsProjection,
): MessagesTimelineRow[] | null {
  const {
    timelineEntries: previousEntries,
    latestRun: previousRun,
    turnDiffSummaries: previousCheckpoints,
    expandedRunIds: previousExpandedRuns,
    expandedAttemptIds: previousExpandedAttempts,
    expandedWorkGroupIds: previousExpandedGroups,
    availableRevertTurnCounts: previousAvailableRevertTurnCounts,
    ...previousContext
  } = previous.input;
  const {
    timelineEntries,
    latestRun,
    turnDiffSummaries,
    expandedRunIds,
    expandedAttemptIds,
    expandedWorkGroupIds,
    availableRevertTurnCounts,
    ...context
  } = input;
  // Shell/checkpoint selectors rebuild summaries per event; compare contents.
  if (
    timelineEntries.length !== previousEntries.length ||
    !shallow(previousContext, context) ||
    !shallow(previousRun, latestRun) ||
    !shallow(previousExpandedRuns, expandedRunIds) ||
    !shallow(previousExpandedAttempts, expandedAttemptIds) ||
    !shallow(previousExpandedGroups, expandedWorkGroupIds) ||
    !shallow(previousAvailableRevertTurnCounts, availableRevertTurnCounts) ||
    !sameCheckpointSummaries(previousCheckpoints, turnDiffSummaries)
  ) {
    return null;
  }
  const replacements = new Map<ChatMessage, Extract<TimelineEntry, { kind: "message" }>>();
  const thoughts = new Map<string, WorkLogEntry>();
  const plans = new Map<string, ProposedPlan>();
  for (let index = 0; index < timelineEntries.length; index += 1) {
    const entry = timelineEntries[index];
    const previousEntry = previousEntries[index];
    if (!entry || !previousEntry) return null;
    if (entry === previousEntry) continue;
    if (
      entry.kind !== previousEntry.kind ||
      entry.id !== previousEntry.id ||
      entry.createdAt !== previousEntry.createdAt ||
      entry.attempt !== previousEntry.attempt
    ) {
      return null;
    }
    if (entry.kind === "work" && previousEntry.kind === "work") {
      if (!isStreamingThoughtUpdate(previousEntry.entry, entry.entry)) return null;
      thoughts.set(entry.id, entry.entry);
      continue;
    }
    if (entry.kind === "proposed-plan" && previousEntry.kind === "proposed-plan") {
      const { planMarkdown: _before, updatedAt: _beforeAt, ...before } = previousEntry.proposedPlan;
      const { planMarkdown: _after, updatedAt: _afterAt, ...after } = entry.proposedPlan;
      if (!shallow(before, after)) return null;
      plans.set(entry.id, entry.proposedPlan);
      continue;
    }
    if (entry.kind !== "message" || previousEntry.kind !== "message") return null;
    if (
      entry.projectedItem !== previousEntry.projectedItem &&
      (entry.projectedItem === undefined ||
        previousEntry.projectedItem === undefined ||
        !isStreamingTurnItemTextUpdate(previousEntry.projectedItem, entry.projectedItem))
    ) {
      return null;
    }
    if (
      entry.message === previousEntry.message &&
      entry.projectedItem === previousEntry.projectedItem
    )
      continue;
    if (!isStreamingMessageTextUpdate(previousEntry.message, entry.message)) return null;
    replacements.set(previousEntry.message, entry);
  }
  if (replacements.size === 0 && thoughts.size === 0 && plans.size === 0) return previous.rows;
  // Rows settle superseded thinking after tool visibility filtering, which these entries
  // have not seen; the fast path keeps item status, so the row's settled status still holds.
  const patchedThoughts = new Map<WorkLogEntry, WorkLogEntry>();
  const patchThought = (entry: WorkLogEntry) => {
    const thought = thoughts.get(entry.id);
    if (!thought) return entry;
    let patched = patchedThoughts.get(entry);
    if (!patched) {
      patched =
        entry.toolLifecycleStatus === thought.toolLifecycleStatus ||
        entry.toolLifecycleStatus === undefined
          ? thought
          : { ...thought, toolLifecycleStatus: entry.toolLifecycleStatus };
      patchedThoughts.set(entry, patched);
    }
    return patched;
  };
  const patchedGroups = new Map<WorkLogEntry[], WorkLogEntry[]>();
  const patchGroup = (group: WorkLogEntry[]) => {
    if (!group.some((entry) => thoughts.has(entry.id))) return group;
    const patched = patchedGroups.get(group) ?? group.map(patchThought);
    patchedGroups.set(group, patched);
    return patched;
  };
  const patchedLiveThoughtIds = new Set<string>();
  const rows = previous.rows.map((row): MessagesTimelineRow => {
    if (row.kind === "proposed-plan") {
      const proposedPlan = plans.get(row.id);
      return proposedPlan ? { ...row, proposedPlan } : row;
    }
    if (row.kind === "work-live") {
      const groupedEntries = patchGroup(row.groupedEntries);
      if (groupedEntries === row.groupedEntries) return row;
      for (const entry of groupedEntries) {
        if (thoughts.has(entry.id)) patchedLiveThoughtIds.add(entry.id);
      }
      return {
        ...row,
        entry: patchThought(row.entry),
        groupedEntries,
        ...(row.thought ? { thought: patchThought(row.thought) } : {}),
      };
    }
    if (row.kind === "work") {
      const groupedEntries = patchGroup(row.groupedEntries);
      return groupedEntries === row.groupedEntries ? row : { ...row, groupedEntries };
    }
    if (row.kind !== "message" && row.kind !== "assistant-meta") return row;
    const entry = replacements.get(row.message);
    return entry
      ? {
          ...row,
          message: entry.message,
          ...(entry.projectedItem === undefined ? {} : { projectedItem: entry.projectedItem }),
        }
      : row;
  });
  // Only a live row holds thinking without deriving a label from its text. Settled
  // groups, folded turns, and work toggles summarize it, so they need the full rebuild.
  for (const id of thoughts.keys()) if (!patchedLiveThoughtIds.has(id)) return null;
  return rows;
}

/**
 * Rows read a thought's text only through its blankness (visibility, the live
 * thought line) and through labels that live rows do not store.
 */
function isStreamingThoughtUpdate(previous: WorkLogEntry, next: WorkLogEntry): boolean {
  if (
    previous.itemType !== "reasoning" ||
    previous.projectedItem === undefined ||
    next.projectedItem === undefined ||
    !isStreamingTurnItemTextUpdate(previous.projectedItem, next.projectedItem) ||
    Boolean(previous.detail?.trim()) !== Boolean(next.detail?.trim())
  ) {
    return false;
  }
  const {
    detail: _before,
    structuredPayload: _beforeItem,
    projectedItem: _beforeRow,
    ...rest
  } = previous;
  const {
    detail: _after,
    structuredPayload: _afterItem,
    projectedItem: _afterRow,
    ...nextRest
  } = next;
  return shallow(rest, nextRest);
}
