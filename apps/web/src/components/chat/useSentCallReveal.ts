import type { LegendListRef } from "@legendapp/list/react";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useState, useSyncExternalStore, type RefObject } from "react";

import type { TimelineEntry } from "../../session-logic";
import { toastManager } from "../ui/toast";
import { goatThreadCallOf } from "./goatThreadCalls";
import type { MessagesTimelineHistoryControls } from "./MessagesTimeline";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

type Entry = Extract<TimelineEntry, { kind: "work" }>["entry"];

/** The call that delivered the message: its thread.send, or the launch that opened the thread with it. */
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
  // A launched thread's opening prompt carries the launch's id as both thread and message id.
  return target.messageId === target.threadId ? launch : null;
}

/**
 * The row showing the call, else the collapsed turn or segment that holds it (post-steer segments
 * fold under their own key, which `foldKeyOf` gives), else its superseded attempt or tool group.
 */
export function sendingCallRowIndex(
  rows: ReadonlyArray<MessagesTimelineRow>,
  entry: Entry,
  foldKeyOf: (entryId: string) => string | undefined,
): number {
  const shown = rows.findIndex(
    (row) =>
      (row.kind === "work" || row.kind === "work-live") &&
      row.groupedEntries.some((grouped) => grouped.id === entry.id),
  );
  if (shown >= 0) return shown;
  const foldKey = foldKeyOf(entry.id);
  const fold =
    foldKey === undefined
      ? -1
      : rows.findIndex((row) => row.kind === "turn-fold" && row.runId === foldKey);
  if (fold >= 0 || entry.runId == null) return fold;
  // A superseded attempt folds its calls under its own row while the replacement runs.
  return rows.findIndex(
    (row) =>
      (row.kind === "attempt-fold" || row.kind === "work-toggle") && row.runId === entry.runId,
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
  /** The thread this timeline shows. */
  readonly threadId: string | null;
  readonly history: MessagesTimelineHistoryControls | undefined;
  readonly foldKeyOf: (entryId: string) => string | undefined;
  readonly onNavigate: () => void;
}) {
  const target = useSentFromState();
  const [handled, setHandled] = useState<string | null>(null);
  const [paging, setPaging] = useState({
    activation: "",
    count: 0,
    atLength: -1,
    sawLoading: false,
  });
  // Right after navigating, the list can still hold the previous thread's entries.
  const showsSender =
    target !== undefined &&
    input.threadId === target.senderThreadId &&
    // Inherited items of a fork keep their source thread, so only this thread's own items count.
    !input.entries.some(
      (entry) =>
        entry.kind === "work" &&
        entry.entry.projectedItem?.visibility === "local" &&
        entry.entry.projectedItem.item.threadId !== target.senderThreadId,
    );
  const pending =
    target !== undefined &&
    target.activation !== handled &&
    showsSender &&
    input.listReady &&
    input.history?.loading !== true;
  const entry = pending ? findSendingCall(input.entries, target) : null;
  const rowIndex = entry === null ? -1 : sendingCallRowIndex(input.rows, entry, input.foldKeyOf);
  const paged = target !== undefined && paging.activation === target.activation;
  const own = pending && paged;
  const pages = own ? paging.count : 0;
  // A page asked for has landed once entries changed or a load ran and ended.
  if (paged && input.history?.loading === true && !paging.sawLoading)
    setPaging({ ...paging, sawLoading: true });
  const awaitingPage = own && paging.atLength === input.entries.length && !paging.sawLoading;
  const loadEarlier =
    pending &&
    rowIndex < 0 &&
    input.history?.hasMoreHistory === true &&
    input.history.error === null &&
    pages < MAX_HISTORY_PAGES
      ? input.history.onLoadEarlier
      : null;
  const { listRef, onNavigate } = input;
  const entryCount = input.entries.length;
  // oxlint-disable-next-line goat/react-effect-budget -- Paging history and scrolling the virtual list are external effects that run once the list has laid out.
  useEffect(() => {
    if (!pending || awaitingPage) return;
    if (loadEarlier !== null) {
      // oxlint-disable-next-line react/set-state-in-effect -- A page is asked for only after the previous one landed; the count bounds the walk.
      setPaging({
        activation: target.activation,
        count: pages + 1,
        atLength: entryCount,
        sawLoading: false,
      });
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
