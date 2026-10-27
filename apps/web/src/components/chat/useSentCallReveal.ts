import type { LegendListRef } from "@legendapp/list/react";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useState, useSyncExternalStore, type RefObject } from "react";

import type { TimelineEntry } from "../../session-logic";
import { toastManager } from "../ui/toast";
import { goatThreadCallOf } from "./goatThreadCalls";
import type { MessagesTimelineHistoryControls } from "./MessagesTimeline";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

type Entry = Extract<TimelineEntry, { kind: "work" }>["entry"];

/** The call that delivered the message: its thread.send, or the launch whose first prompt it is. */
export function findSendingCall(
  entries: ReadonlyArray<TimelineEntry>,
  target: { readonly threadId: string; readonly messageId: string },
): Entry | null {
  let launch: Entry | null = null;
  for (const timelineEntry of entries) {
    if (timelineEntry.kind !== "work") continue;
    const call = goatThreadCallOf(timelineEntry.entry);
    if (call === null || !call.threadIds.includes(target.threadId)) continue;
    if (call.kind === "send" && call.messageId === target.messageId) return timelineEntry.entry;
    if (call.kind !== "send") launch ??= timelineEntry.entry;
  }
  return launch;
}

/** The row showing the call, or the collapsed group or turn that holds it. */
export function sendingCallRowIndex(
  rows: ReadonlyArray<MessagesTimelineRow>,
  entry: Entry,
): number {
  const shown = rows.findIndex(
    (row) =>
      (row.kind === "work" || row.kind === "work-live") &&
      row.groupedEntries.some((grouped) => grouped.id === entry.id),
  );
  if (shown >= 0 || entry.runId == null) return shown;
  return rows.findIndex(
    (row) => (row.kind === "work-toggle" || row.kind === "turn-fold") && row.runId === entry.runId,
  );
}

const MAX_HISTORY_PAGES = 20;
const NO_UNSUBSCRIBE = () => {};

// Timelines also render outside a router (tests, previews); they have no sent-from target.
function useSentFromState() {
  const router = useRouter({ warn: false });
  return useSyncExternalStore(
    (onChange) => router?.history.subscribe(onChange) ?? NO_UNSUBSCRIBE,
    () => router?.history.location.state.sentFrom,
  );
}

/**
 * Opening a thread from a message it sent elsewhere scrolls to the call that sent it, once per
 * click, loading earlier history while the call is older than what is loaded. A call it cannot
 * reach says so instead of leaving the person at the end without a word.
 */
export function useSentCallReveal(input: {
  readonly entries: ReadonlyArray<TimelineEntry>;
  readonly rows: ReadonlyArray<MessagesTimelineRow>;
  readonly listRef: RefObject<LegendListRef | null>;
  readonly listReady: boolean;
  readonly history: MessagesTimelineHistoryControls | undefined;
  readonly onNavigate: () => void;
}) {
  const target = useSentFromState();
  const [handled, setHandled] = useState<string | null>(null);
  const [paging, setPaging] = useState({ activation: "", count: 0, atLength: -1 });
  // Right after navigating, the list can still hold the previous thread's entries.
  const showsSender = input.entries.some(
    (entry) =>
      entry.kind === "work" && entry.entry.structuredPayload?.threadId === target?.senderThreadId,
  );
  const pending =
    target !== undefined &&
    target.activation !== handled &&
    showsSender &&
    input.listReady &&
    input.entries.length > 0 &&
    input.history?.loading !== true;
  const entry = pending ? findSendingCall(input.entries, target) : null;
  const rowIndex = entry === null ? -1 : sendingCallRowIndex(input.rows, entry);
  const own = pending && paging.activation === target.activation;
  const pages = own ? paging.count : 0;
  // Wait for the page asked for to land before asking for the next one.
  const awaitingPage = own && paging.atLength === input.entries.length;
  const loadEarlier =
    pending && rowIndex < 0 && input.history?.hasMoreHistory === true && pages < MAX_HISTORY_PAGES
      ? input.history.onLoadEarlier
      : null;
  const { listRef, onNavigate } = input;
  const entryCount = input.entries.length;
  // oxlint-disable-next-line goat/react-effect-budget -- Paging history and scrolling the virtual list are external effects that run once the list has laid out.
  useEffect(() => {
    if (!pending || awaitingPage) return;
    if (loadEarlier !== null) {
      // oxlint-disable-next-line react/set-state-in-effect -- A page is asked for only after the previous one landed; the count bounds the walk.
      setPaging({ activation: target.activation, count: pages + 1, atLength: entryCount });
      loadEarlier();
      return;
    }
    setHandled(target.activation);
    if (rowIndex < 0) {
      toastManager.add({ type: "info", title: "The call that sent this message isn't available" });
      return;
    }
    onNavigate();
    void listRef.current?.scrollToIndex({ index: rowIndex, animated: false, viewOffset: 24 });
  }, [
    pending,
    awaitingPage,
    target,
    rowIndex,
    pages,
    entryCount,
    loadEarlier,
    listRef,
    onNavigate,
  ]);
}
