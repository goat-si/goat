import type { ResponseStreamingMode } from "@goat/contracts";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import { hasAssistantTextBoundary } from "./Adapters/AssistantTextBoundary.ts";

// List fences can open at any indentation; closers may be at most three spaces deeper.
const MARKDOWN_FENCE_PATTERN = /^( *)(`{3,}|~{3,})/;
// CommonMark blank lines contain only spaces and tabs.
const BLANK_LINE_PATTERN = /^[ \t]*$/;
// Require trailing space so partial list markers cannot match during streaming.
const LIST_ITEM_START_PATTERN = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]/;
const SECTION_TITLE_PATTERN = /^ {0,3}(?:#{1,6}(?:[ \t]|$)|\*\*(?:[^*]|\*(?!\*))+\*\*:?$)/;
// Unindented ATX headings end preceding paragraphs and lists without blank lines; bold lines do not.
const TOP_LEVEL_HEADING_PATTERN = /^#{1,6}(?:[ \t]|$)/;

// Matches LIST_ITEM_START_PATTERN on the trimmed partial line without copying it.
const PARTIAL_LIST_ITEM_START_PATTERN = /[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t][ \t\r]*[^ \t\r]/y;

interface AssistantTextScan {
  readonly text: string;
  // Start of the partial line; every line before it has been scanned.
  readonly lineStart: number;
  readonly openFence: { readonly marker: string; readonly indent: number } | null;
  readonly boundary: number;
  readonly titleAwaitingContent: boolean;
}

const EMPTY_SCAN: AssistantTextScan = {
  text: "",
  lineStart: 0,
  openFence: null,
  boundary: -1,
  titleAwaitingContent: false,
};

function trimLineEnd(text: string, start: number, end: number): string {
  while (end > start) {
    const char = text.charCodeAt(end - 1);
    if (char !== 32 && char !== 9 && char !== 13) break;
    end--;
  }
  return text.slice(start, end);
}

/** Scans the terminated lines of `text`, resuming after `previous` when `text` extends it. */
function advanceScan(previous: AssistantTextScan, text: string): AssistantTextScan {
  const resumed = text.startsWith(previous.text);
  let { openFence, boundary, lineStart, titleAwaitingContent } = resumed ? previous : EMPTY_SCAN;
  let searchFrom = resumed ? previous.text.length : 0;
  for (;;) {
    const newline = text.indexOf("\n", searchFrom);
    if (newline === -1) break;
    const line = trimLineEnd(text, lineStart, newline);
    if (
      openFence === null &&
      lineStart > 0 &&
      !titleAwaitingContent &&
      LIST_ITEM_START_PATTERN.test(line)
    ) {
      boundary = lineStart;
    }
    const fenceMatch = MARKDOWN_FENCE_PATTERN.exec(line);
    if (fenceMatch) {
      const indent = fenceMatch[1]!.length;
      const marker = fenceMatch[2]!;
      if (openFence === null) {
        openFence = { marker, indent };
        titleAwaitingContent = false;
      } else if (
        marker[0] === openFence.marker[0] &&
        marker.length >= openFence.marker.length &&
        indent <= openFence.indent + 3 &&
        line.length === indent + marker.length
      ) {
        // CommonMark: a closing fence carries no info string.
        openFence = null;
        boundary = newline + 1;
      }
    } else if (openFence === null && BLANK_LINE_PATTERN.test(line) && lineStart > 0) {
      if (!titleAwaitingContent) {
        boundary = newline + 1;
      }
    } else if (openFence === null) {
      if (lineStart > 0 && !titleAwaitingContent && TOP_LEVEL_HEADING_PATTERN.test(line)) {
        boundary = lineStart;
      }
      titleAwaitingContent = SECTION_TITLE_PATTERN.test(line);
    }
    lineStart = newline + 1;
    searchFrom = lineStart;
  }
  return { text, lineStart, openFence, boundary, titleAwaitingContent };
}

// The partial line may still change, so its list item start is checked here, not kept in the scan.
function readyBoundary(scan: AssistantTextScan): number {
  if (scan.openFence === null && scan.lineStart > 0 && !scan.titleAwaitingContent) {
    PARTIAL_LIST_ITEM_START_PATTERN.lastIndex = scan.lineStart;
    if (PARTIAL_LIST_ITEM_START_PATTERN.test(scan.text)) return scan.lineStart;
  }
  return scan.boundary;
}

/** Emit terminated lines only, except partial list-start lookahead for tight lists. Hold section titles until content follows. */
export function splitBufferedAssistantText(text: string): { ready: string; rest: string } {
  const boundary = readyBoundary(advanceScan(EMPTY_SCAN, text));
  if (boundary === -1) {
    return { ready: "", rest: text };
  }
  return { ready: text.slice(0, boundary), rest: text.slice(boundary) };
}

const ASSISTANT_IDLE_FLUSH_MS = 800;
// Per run; an evicted item loses only its early partial, and its final update still arrives whole.
const MAX_STREAMING_TRACKS = 256;

type Event = ProviderAdapter.ProviderAdapterV2Event;
type Track = {
  text: string;
  at: number;
  held: Event | null;
  dueAt: number;
  scan: AssistantTextScan;
};

function streamedText(event: Event) {
  if (event.type === "message.updated" && event.message.role === "assistant") return event.message;
  if (
    event.type === "turn_item.updated" &&
    (event.turnItem.type === "assistant_message" || event.turnItem.type === "reasoning")
  )
    return event.turnItem;
  return null;
}

function withText(event: Event, text: string): Event {
  if (event.type === "message.updated") return { ...event, message: { ...event.message, text } };
  if (
    event.type === "turn_item.updated" &&
    (event.turnItem.type === "assistant_message" || event.turnItem.type === "reasoning")
  )
    return { ...event, turnItem: { ...event.turnItem, text } };
  return event;
}

export function makeAssistantStreamingFilter(
  mode: ResponseStreamingMode,
  options?: { readonly receiptLine: boolean },
) {
  const tracks = new Map<string, Track>();
  let receiptItem: string | null = null;
  let receiptText: string | null = null;
  let nextDueAt: number | null = null;
  const track = (key: string, value: Track) => {
    tracks.delete(key);
    tracks.set(key, value);
    if (tracks.size > MAX_STREAMING_TRACKS) {
      const oldest = tracks.keys().next().value;
      if (oldest !== undefined) tracks.delete(oldest);
    }
    if (value.held !== null && (nextDueAt === null || value.dueAt < nextDueAt))
      nextDueAt = value.dueAt;
  };
  const filter = (event: Event, now: number): Event | null => {
    if (
      event.type === "node.updated" &&
      event.node.kind === "assistant_message" &&
      event.node.status === "running"
    )
      return null;
    const message = streamedText(event);
    if (!message) return event;
    const key = `${event.type}:${message.id}`;
    const assistant =
      event.type === "message.updated" ||
      (event.type === "turn_item.updated" && event.turnItem.type === "assistant_message");
    const root =
      message.runId !== null &&
      (event.type !== "turn_item.updated" || event.turnItem.parentItemId === null);
    if (options?.receiptLine && assistant && root && receiptText === null) {
      const newline = message.text.indexOf("\n");
      if (newline !== -1 || !message.streaming || hasAssistantTextBoundary(event)) {
        const line = newline === -1 ? message.text : message.text.slice(0, newline + 1);
        if (line.trim().length > 0) {
          receiptItem = String(message.id);
          receiptText = line;
        }
      }
    }
    if (!message.streaming) {
      tracks.delete(key);
      return event;
    }
    const previous = tracks.get(key);
    const firstReceipt =
      receiptItem === String(message.id) &&
      receiptText !== null &&
      (previous === undefined || previous.at === Number.NEGATIVE_INFINITY);
    if (mode === "turn" && !firstReceipt) return null;
    const delivered = previous?.text ?? "";
    const hold = (scan = previous?.scan ?? EMPTY_SCAN) => {
      const canFlush =
        mode === "paragraph" &&
        !(options?.receiptLine && assistant && root && receiptText === null);
      track(key, {
        text: delivered,
        at: previous?.at ?? Number.NEGATIVE_INFINITY,
        held: canFlush && message.text !== delivered ? event : null,
        dueAt: now + ASSISTANT_IDLE_FLUSH_MS,
        scan,
      });
      return null;
    };
    if (!firstReceipt && previous && now - previous.at < 400) return hold();
    const scan = advanceScan(previous?.scan ?? EMPTY_SCAN, message.text);
    const boundary = readyBoundary(scan);
    const ready = firstReceipt
      ? receiptText
      : boundary === -1
        ? ""
        : message.text.slice(0, boundary);
    // An idle delivery may already show more than the next boundary; never shrink it. A
    // provider rewrite or truncation is not a prefix and replaces it.
    if (!ready || delivered.startsWith(ready)) return hold(scan);
    track(key, {
      text: ready,
      at: now,
      held: mode === "paragraph" && ready !== message.text ? event : null,
      dueAt: now + ASSISTANT_IDLE_FLUSH_MS,
      scan,
    });
    return withText(event, ready);
  };
  return Object.assign(filter, {
    nextIdleFlushAt: () => nextDueAt,
    takeIdleFlushes(now: number): ReadonlyArray<Event> {
      const due: Event[] = [];
      nextDueAt = null;
      for (const [key, current] of tracks) {
        if (current.held === null) continue;
        if (current.dueAt > now) {
          if (nextDueAt === null || current.dueAt < nextDueAt) nextDueAt = current.dueAt;
          continue;
        }
        due.push(current.held);
        tracks.set(key, {
          text: streamedText(current.held)?.text ?? current.text,
          at: now,
          held: null,
          dueAt: now,
          scan: current.scan,
        });
      }
      return due;
    },
  });
}
