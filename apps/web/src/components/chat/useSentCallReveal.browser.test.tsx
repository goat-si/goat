import type { LegendListRef } from "@legendapp/list/react";
import { MessageId, ThreadId } from "@goat/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import type { TimelineEntry } from "../../session-logic";
import { toastManager } from "../ui/toast";
import { callTimelineEntry } from "./goatThreadCalls.fixtures";
import type { MessagesTimelineHistoryControls } from "./MessagesTimeline";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import { useSentCallReveal } from "./useSentCallReveal";

const SENDER = "thread-sender";
const LANE = "thread-lane";

const sendCall = callTimelineEntry(
  "goat_thread_send",
  { threadId: LANE },
  { threadId: LANE, messageId: "message-1" },
  "completed",
  "send",
  SENDER,
);
const otherThreadCall = callTimelineEntry(
  "goat_thread_read",
  { threadId: "x" },
  { thread: {} },
  "completed",
  "read",
  LANE,
);
const messageOnly: TimelineEntry = {
  id: "entry-message",
  kind: "message",
  createdAt: "2026-10-27T00:00:00.000Z",
  message: {
    id: MessageId.make("message-recent"),
    role: "assistant",
    text: "Lanes are running.",
    runId: null,
    createdAt: "2026-10-27T00:00:00.000Z",
    updatedAt: "2026-10-27T00:00:00.000Z",
    streaming: false,
  },
};
const rowsFor = (entries: ReadonlyArray<TimelineEntry>): MessagesTimelineRow[] =>
  entries.flatMap((entry, index) =>
    entry.kind === "work"
      ? [
          {
            kind: "work" as const,
            id: `row-${index}`,
            createdAt: entry.createdAt,
            groupedEntries: [entry.entry],
            isExpandedToolGroup: false,
          },
        ]
      : [],
  );

function Reveal(props: {
  readonly entries: ReadonlyArray<TimelineEntry>;
  readonly threadId: string;
  readonly history?: MessagesTimelineHistoryControls;
  readonly listRef: React.RefObject<LegendListRef | null>;
}) {
  useSentCallReveal({
    entries: props.entries,
    rows: rowsFor(props.entries),
    listRef: props.listRef,
    listReady: true,
    threadId: props.threadId,
    history: props.history,
    onNavigate: () => {},
  });
  return null;
}

function scrollSpy() {
  const scrollToIndex = vi.fn(async () => {});
  const listRef: React.RefObject<LegendListRef | null> = {
    current: { scrollToIndex } as unknown as LegendListRef,
  };
  return { listRef, scrollToIndex };
}

const sentFrom = {
  threadId: ThreadId.make(LANE),
  messageId: MessageId.make("message-1"),
  senderThreadId: ThreadId.make(SENDER),
  activation: "click-1",
};

describe("useSentCallReveal", () => {
  it("waits for the sender's entries, then scrolls to the call that sent the message", async () => {
    const { listRef, scrollToIndex } = scrollSpy();
    await using screen = await render(
      <Reveal entries={[otherThreadCall]} threadId={SENDER} listRef={listRef} />,
      { router: "/thread" },
    );
    await act(() => screen.router!.history.push("/thread", { sentFrom }));
    // The previous thread's entries are still on screen: nothing happens yet.
    expect(scrollToIndex).not.toHaveBeenCalled();

    await screen.rerender(<Reveal entries={[sendCall]} threadId={SENDER} listRef={listRef} />);
    await vi.waitFor(() =>
      expect(scrollToIndex).toHaveBeenCalledWith(expect.objectContaining({ index: 0 })),
    );
  });

  it("loads earlier history from a page with only messages until it finds the call", async () => {
    const { listRef, scrollToIndex } = scrollSpy();
    const onLoadEarlier = vi.fn();
    const history = (loading: boolean, hasMoreHistory = true): MessagesTimelineHistoryControls => ({
      hasMoreHistory,
      loading,
      error: null,
      onLoadEarlier,
    });
    await using screen = await render(
      <Reveal
        entries={[messageOnly]}
        threadId={SENDER}
        history={history(false)}
        listRef={listRef}
      />,
      { router: "/thread" },
    );
    await act(() => screen.router!.history.push("/thread", { sentFrom }));
    await vi.waitFor(() => expect(onLoadEarlier).toHaveBeenCalledTimes(1));

    await screen.rerender(
      <Reveal
        entries={[messageOnly]}
        threadId={SENDER}
        history={history(true)}
        listRef={listRef}
      />,
    );
    await screen.rerender(
      <Reveal
        entries={[sendCall, messageOnly]}
        threadId={SENDER}
        history={history(false, false)}
        listRef={listRef}
      />,
    );
    await vi.waitFor(() =>
      expect(scrollToIndex).toHaveBeenCalledWith(expect.objectContaining({ index: 0 })),
    );
    expect(onLoadEarlier).toHaveBeenCalledTimes(1);
  });

  it("stops and says so when an earlier page fails to load", async () => {
    const { listRef, scrollToIndex } = scrollSpy();
    using toast = vi.spyOn(toastManager, "add");
    const onLoadEarlier = vi.fn();
    await using screen = await render(
      <Reveal
        entries={[messageOnly]}
        threadId={SENDER}
        history={{ hasMoreHistory: true, loading: false, error: null, onLoadEarlier }}
        listRef={listRef}
      />,
      { router: "/thread" },
    );
    await act(() => screen.router!.history.push("/thread", { sentFrom }));
    await vi.waitFor(() => expect(onLoadEarlier).toHaveBeenCalledTimes(1));
    await screen.rerender(
      <Reveal
        entries={[messageOnly]}
        threadId={SENDER}
        history={{ hasMoreHistory: true, loading: true, error: null, onLoadEarlier }}
        listRef={listRef}
      />,
    );
    await screen.rerender(
      <Reveal
        entries={[messageOnly]}
        threadId={SENDER}
        history={{ hasMoreHistory: true, loading: false, error: "Network error", onLoadEarlier }}
        listRef={listRef}
      />,
    );
    await vi.waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "The call that sent this message isn't available" }),
      ),
    );
    expect(onLoadEarlier).toHaveBeenCalledTimes(1);
    expect(scrollToIndex).not.toHaveBeenCalled();
  });
});
