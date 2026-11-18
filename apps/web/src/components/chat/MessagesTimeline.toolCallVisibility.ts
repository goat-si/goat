import {
  liveThoughtLine,
  workEntryHiddenByToolCallVisibility,
} from "@goat/client-runtime/work-log/presentation";
import type { MessageId, RunId } from "@goat/contracts";
import type { ToolCallVisibility } from "@goat/contracts/settings";

import { useClientSettings } from "../../hooks/useSettings";
import type { AssistantCitationRequest } from "./AssistantCitationSource";

import type { TimelineEntry } from "../../session-logic";
import { deriveTerminalAssistantMessageIds } from "./terminalAssistantMessages";
import type { TimelineLatestRun } from "./timelineLatestRun";
import { deriveUnsettledRunId } from "./timelineLiveRun";
import {
  lastResponseBoundaryIndex,
  timelineEntryIsCompaction,
  timelineEntryIsSteer,
  timelineEntryStartsResponse,
} from "./timelineResponseBoundary";

export interface ToolCallVisibilityInput {
  readonly timelineEntries: ReadonlyArray<TimelineEntry>;
  readonly toolCallVisibility?: ToolCallVisibility | undefined;
  /** A cited message stays visible in zen even when it is not a final answer. */
  readonly revealedMessageId?: MessageId | null | undefined;
  readonly latestRun?: TimelineLatestRun | null | undefined;
  readonly runningRunId?: RunId | null | undefined;
}

// Zen keeps what needs the person or explains the turn: open approvals, answered questions,
// compactions, notifications, errors, and the response boundaries.
function workShownAsFinalAnswerOnly(entry: TimelineEntry): boolean {
  if (entry.kind === "event") return entry.projectedItem.item.type !== "subagent";
  if (entry.kind !== "work") return true;
  const work = entry.entry;
  const item = work.projectedItem?.item;
  return (
    (item?.type === "approval_request" &&
      (item.status === "pending" || item.status === "running")) ||
    work.questionAnswer !== undefined ||
    timelineEntryIsCompaction(entry) ||
    timelineEntryStartsResponse(entry) ||
    work.tone === "error" ||
    work.sourceActivityKind === "runtime.error" ||
    (work.itemType === "error" && work.toolLifecycleStatus !== "completed")
  );
}

function deriveInFlightSteerAnswerIds(entries: ReadonlyArray<TimelineEntry>): ReadonlySet<string> {
  const ids = new Set<string>();
  let awaitingReply = false;
  let candidate: string | null = null;
  for (const entry of entries) {
    if (entry.kind === "work" && entry.entry.itemType === "reasoning") continue;
    const reply = entry.kind === "message" && entry.message.role === "assistant" ? entry : null;
    if (candidate !== null && reply !== null) ids.add(candidate);
    candidate = null;
    if (timelineEntryIsSteer(entry)) {
      awaitingReply = true;
    } else if (entry.kind === "message" && entry.message.role === "user") {
      awaitingReply = false;
    } else if (reply !== null && awaitingReply) {
      candidate = reply.message.id;
      awaitingReply = false;
    }
  }
  return ids;
}

/** In zen, the live row reads the latest line the agent wrote or thought in the open response. */
export function liveAnswerPreview(entries: ReadonlyArray<TimelineEntry>): string | null {
  const boundary = lastResponseBoundaryIndex(entries);
  for (let index = entries.length - 1; index > boundary; index -= 1) {
    const entry = entries[index];
    if (entry === undefined) continue;
    const text =
      entry.kind === "message" && entry.message.role === "assistant"
        ? entry.message.text
        : entry.kind === "work" && entry.entry.itemType === "reasoning"
          ? (entry.entry.detail ?? "")
          : "";
    const line = liveThoughtLine(text);
    if (line !== "") return line;
  }
  return null;
}

/** The person's Labs choice, with zen shown as hideAll while find is open; a citation stays shown. */
export function useTimelineDisplay(
  findActive: boolean,
  citationRequest: AssistantCitationRequest | null,
): {
  readonly toolCallVisibility: ToolCallVisibility;
  readonly revealedMessageId: MessageId | null;
} {
  const preferred = useClientSettings((settings) => settings.toolCallVisibility);
  return {
    toolCallVisibility: findActive && preferred === "zen" ? "hideAll" : preferred,
    revealedMessageId: citationRequest?.citation.messageId ?? null,
  };
}

/** The entries a thread shows under the person's tool-call visibility. */
export function entriesShownForToolCallVisibility(
  input: ToolCallVisibilityInput,
  isWorking: boolean,
  retainedReplyEntryIds: (entries: ReadonlyArray<TimelineEntry>) => ReadonlySet<string>,
): ReadonlyArray<TimelineEntry> {
  const visibility = input.toolCallVisibility ?? "showAll";
  const entries = input.timelineEntries;
  if (visibility === "showAll") return entries;
  if (visibility !== "zen") {
    return entries.filter(
      (entry) =>
        entry.kind !== "work" || !workEntryHiddenByToolCallVisibility(entry.entry, visibility),
    );
  }
  const answering = isWorking && input.latestRun?.turnEnded !== true;
  const answeringRunId = answering
    ? deriveUnsettledRunId(input.latestRun ?? null, input.runningRunId ?? null)
    : null;
  const answeringFrom = answering ? lastResponseBoundaryIndex(entries) + 1 : entries.length;
  const terminalIds = deriveTerminalAssistantMessageIds(entries);
  const steerAnswerIds = deriveInFlightSteerAnswerIds(entries);
  const retainedReplyIds = retainedReplyEntryIds(entries);
  return entries.filter((entry, index) => {
    if (entry.kind !== "message") return workShownAsFinalAnswerOnly(entry);
    const { message } = entry;
    return (
      message.role !== "assistant" ||
      message.id === input.revealedMessageId ||
      steerAnswerIds.has(message.id) ||
      retainedReplyIds.has(entry.id) ||
      (terminalIds.has(message.id) &&
        index < answeringFrom &&
        (answeringRunId === null || message.runId !== answeringRunId))
    );
  });
}
