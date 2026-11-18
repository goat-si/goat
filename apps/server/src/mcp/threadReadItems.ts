import type {
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
  OrchestratorMcpThreadTimelineItem,
  ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";

// Claude Code saves MCP results over ~25k tokens to a file instead of showing them. Bytes, not
// chars: CJK text runs near one token per char, which a char budget lets through at 30k tokens.
const THREAD_READ_RESULT_MAX_BYTES = 30_000;

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function turnItemText(item: OrchestrationV2TurnItem): string | null {
  switch (item.type) {
    case "notification":
      return [item.summary, item.detail].filter((part) => part !== undefined).join("\n");
    case "user_message":
    case "assistant_message":
    case "reasoning":
      return item.text;
    case "proposed_plan":
      return item.markdown;
    case "todo_list":
      return [item.explanation, ...item.steps.map((step) => `[${step.status}] ${step.text}`)]
        .filter((line): line is string => line !== undefined)
        .join("\n");
    case "user_input_request":
      return jsonText(item.questions);
    case "file_change":
      return [
        item.fileName,
        item.additions === undefined && item.deletions === undefined
          ? undefined
          : `+${item.additions ?? 0} -${item.deletions ?? 0}`,
        item.diffStr ?? item.newStr,
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n");
    case "command_execution":
      return [`$ ${item.input}`, item.output]
        .filter((line): line is string => line !== undefined)
        .join("\n");
    case "file_search":
      return jsonText({ pattern: item.pattern, results: item.results });
    case "web_search":
      return jsonText({ patterns: item.patterns, results: item.results });
    case "approval_request":
      return [item.prompt ?? item.requestKind, item.reason]
        .filter((line): line is string => line !== undefined)
        .join("\n");
    case "checkpoint":
      return jsonText(item.files);
    case "run_interrupt_request":
    case "run_interrupt_result":
    case "system_notice":
      return item.message;
    case "error":
      return item.failure.message;
    case "compaction":
      return item.summary ?? null;
    case "handoff":
      return item.summary ?? `${item.strategy} handoff to ${item.toProviderInstanceId}`;
    case "fork":
      return `Forked to thread ${item.targetThreadId}.`;
    case "thread_created":
      return `Created thread ${item.targetThreadId} with ${item.targetProviderInstanceId} (${item.targetModel}).`;
    case "human_handoff":
      return `${item.handoff.title}: ${item.handoff.state} (${item.handoff.target.path})`;
    case "secret_request":
      return `Asked the user for ${item.label}: ${item.secretStatus}.`;
    case "subagent":
      return item.result ?? item.progress ?? item.prompt;
    case "dynamic_tool":
      return jsonText({ toolName: item.toolName, input: item.input, output: item.output });
  }
}

function textPageEnd(text: string | null, offset: number, maxChars: number): number {
  const end = offset + maxChars;
  if (text === null || end >= text.length) return end;
  const last = text.charCodeAt(end - 1);
  if (last < 0xd800 || last > 0xdbff) return end;
  return end - 1 > offset ? end - 1 : end + 1;
}

function timelineItem(input: {
  readonly row: OrchestrationV2ThreadProjection["visibleTurnItems"][number];
  readonly maxChars: number;
  readonly textOffset?: number;
  readonly messagesByThreadId: ReadonlyMap<ThreadId, OrchestrationV2ThreadProjection["messages"]>;
  readonly tasksByThreadId: ReadonlyMap<ThreadId, OrchestrationV2ThreadProjection["subagents"]>;
}): OrchestratorMcpThreadTimelineItem {
  const item = input.row.item;
  const task =
    item.type === "subagent"
      ? input.tasksByThreadId
          .get(input.row.sourceThreadId)
          ?.find((task) => task.id === item.subagentId)
      : undefined;
  const text = turnItemText(item);
  const offset = input.textOffset ?? 0;
  const end = textPageEnd(text, offset, input.maxChars);
  const textTruncated = text !== null && text.length > end;
  const messageId =
    input.row.item.type === "user_message" || input.row.item.type === "assistant_message"
      ? input.row.item.messageId
      : null;
  const message =
    messageId === null
      ? undefined
      : input.messagesByThreadId
          .get(input.row.sourceThreadId)
          ?.find((candidate) => candidate.id === messageId);
  return {
    position: input.row.position,
    visibility: input.row.visibility,
    sourceThreadId: input.row.sourceThreadId,
    itemId: input.row.sourceItemId,
    ...(input.row.item.type === "subagent" ? { subagentId: input.row.item.subagentId } : {}),
    ...(task?.role === undefined ? {} : { role: task.role }),
    ...(task?.modelSelection === undefined ? {} : { modelSelection: task.modelSelection }),
    ...(task?.parentModelSelection === undefined
      ? {}
      : { parentModelSelection: task.parentModelSelection }),
    runId: input.row.item.runId,
    messageId,
    createdBy: message?.createdBy ?? null,
    creationSource: message?.creationSource ?? null,
    ...(message?.senderThreadId === undefined ? {} : { senderThreadId: message.senderThreadId }),
    type: input.row.item.type,
    status: input.row.item.status,
    title: input.row.item.title,
    text: text === null ? null : text.slice(offset, end),
    textTruncated,
    nextTextOffset: textTruncated ? end : null,
    updatedAt: DateTime.formatIso(input.row.item.updatedAt),
  };
}

type TimelineItemInput = Parameters<typeof timelineItem>[0];

const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

/** The longest prefix length in [low, high] that `fits`, or `low - 1`. */
function longestFitting(low: number, high: number, fits: (length: number) => boolean): number {
  let best = low - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (fits(mid)) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

/** The item with its text cut, and an oversized title too, until its JSON fits `maxBytes`. */
function timelineItemWithin(
  input: TimelineItemInput,
  maxBytes: number,
): OrchestratorMcpThreadTimelineItem {
  const longestText = (title: string | null) => {
    const withText = (maxChars: number) => ({ ...timelineItem({ ...input, maxChars }), title });
    const chars = longestFitting(2, input.maxChars - 1, (n) => jsonBytes(withText(n)) <= maxBytes);
    return withText(Math.max(chars, 1));
  };
  const item = longestText(input.row.item.title);
  const title = item.title;
  if (title === null || jsonBytes(item) <= maxBytes) return item;
  // Half the budget for the title keeps `textOffset` pages of the text useful.
  const cutTitle = (chars: number) =>
    title.slice(0, chars === 0 ? 0 : textPageEnd(title, 0, chars));
  const titleChars = longestFitting(
    1,
    title.length - 1,
    (n) => jsonBytes({ ...item, title: cutTitle(n) }) <= maxBytes / 2,
  );
  return longestText(cutTitle(Math.max(titleChars, 0)));
}

/**
 * The items, read from the end the caller pages toward, whose result with `envelope` fits
 * THREAD_READ_RESULT_MAX_BYTES; `start` is the first kept index. Never empty for a non-empty page.
 */
export function timelineItemsWithinBudget(
  envelope: object,
  inputs: ReadonlyArray<TimelineItemInput>,
  newestFirst: boolean,
): { readonly items: Array<OrchestratorMcpThreadTimelineItem>; readonly start: number } {
  // An oversized envelope (say, a huge thread title) must not starve items to one char per read.
  const budget = Math.max(
    THREAD_READ_RESULT_MAX_BYTES - jsonBytes({ ...envelope, items: [] }),
    THREAD_READ_RESULT_MAX_BYTES / 2,
  );
  const items: Array<OrchestratorMcpThreadTimelineItem> = [];
  let bytes = 0;
  for (const input of newestFirst ? inputs.toReversed() : inputs) {
    const item = timelineItem(input);
    bytes += jsonBytes(item) + (items.length === 0 ? 0 : 1);
    if (bytes <= budget) {
      items.push(item);
      continue;
    }
    if (items.length === 0) items.push(timelineItemWithin(input, budget));
    break;
  }
  return newestFirst
    ? { items: items.toReversed(), start: inputs.length - items.length }
    : { items, start: 0 };
}
