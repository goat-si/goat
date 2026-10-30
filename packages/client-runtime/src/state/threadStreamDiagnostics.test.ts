import { describe, expect, it } from "vite-plus/test";

import {
  formatThreadStreamReport,
  noteThreadFeedReplyRow,
  noteThreadStreamClosed,
  noteThreadStreamEvents,
  noteThreadStreamOpened,
  noteThreadStreamSnapshot,
  noteThreadStreamStatus,
  noteThreadStreamSubscribed,
  noteThreadStreamSynchronized,
  readThreadStreamDiagnostics,
  replyProgress,
  resetThreadStreamDiagnosticsForTest,
  subscribeThreadStreamDiagnostics,
} from "./threadStreamDiagnostics.ts";

const events = (
  sequence: number,
  options: { readonly unknown?: number; readonly reply?: [number | null, number | null] } = {},
) => ({
  known: options.unknown === undefined ? 1 : 0,
  unknown: options.unknown ?? 0,
  sequence,
  eventType: options.reply === undefined ? null : "turn-item.updated",
  reply:
    options.reply === undefined
      ? null
      : {
          messageId: "message-1",
          receivedLength: options.reply[0],
          appliedLength: options.reply[1],
        },
  status: "live",
  hasError: false,
});

function setup() {
  let now = 1_000;
  resetThreadStreamDiagnosticsForTest(() => now);
  noteThreadStreamOpened("env", "thread");
  return {
    advance: (ms: number) => {
      now += ms;
    },
    thread: () => readThreadStreamDiagnostics()[0],
    report: () => formatThreadStreamReport(readThreadStreamDiagnostics()),
  };
}

describe("thread stream diagnostics", () => {
  it("names how each subscription attempt started", () => {
    const { thread } = setup();
    noteThreadStreamSnapshot("env", "thread", { sequence: 4, source: "http", reply: null });
    noteThreadStreamSubscribed("env", "thread", { afterSequence: 4, completionMarker: true });
    expect(thread()?.lastStart).toBe("http snapshot");

    noteThreadStreamSubscribed("env", "thread", { afterSequence: 4, completionMarker: true });
    noteThreadStreamSynchronized("env", "thread");
    noteThreadStreamEvents("env", "thread", events(5));
    expect(thread()).toMatchObject({ lastStart: "up to date", replayedEvents: 0, liveEvents: 1 });

    noteThreadStreamSubscribed("env", "thread", { afterSequence: 5, completionMarker: true });
    noteThreadStreamEvents("env", "thread", events(6));
    noteThreadStreamSynchronized("env", "thread");
    expect(thread()).toMatchObject({ lastStart: "replay", replayedEvents: 1, subscriptions: 3 });

    noteThreadStreamSubscribed("env", "thread", { afterSequence: 6, completionMarker: false });
    noteThreadStreamEvents("env", "thread", events(7));
    expect(thread()).toMatchObject({
      lastStart: "events, replay or live unclear",
      unclearEvents: 1,
    });
  });

  it("counts unknown event types and the cursor they advance", () => {
    const { thread } = setup();
    noteThreadStreamSubscribed("env", "thread", { afterSequence: null, completionMarker: false });
    noteThreadStreamEvents("env", "thread", events(9, { unknown: 2 }));
    expect(thread()).toMatchObject({ liveEvents: 2, unknownEvents: 2, lastSequence: 9 });
  });

  it.each([
    {
      layer: "the client state",
      applied: 10,
      visible: true,
      expected: "in state 10, row committed 10",
    },
    { layer: "the list", applied: 40, visible: true, expected: "in state 40, row committed 10" },
    { layer: "an offscreen row", applied: 40, visible: false, expected: "offscreen" },
  ])(
    "shows a reply that grew on the socket but stalled at $layer",
    ({ applied, visible, expected }) => {
      const { report } = setup();
      noteThreadStreamEvents("env", "thread", events(1, { reply: [10, 10] }));
      noteThreadFeedReplyRow("env", "thread", "message-1", { length: 10, visible });
      noteThreadStreamEvents("env", "thread", events(2, { reply: [40, applied] }));
      expect(report()).toContain("latest reply message-1: received 40 chars via event");
      expect(report()).toContain(expected);
    },
  );

  it("keeps the source, length and time of a body a deduplicated update refers to", () => {
    const { thread, advance } = setup();
    const reply = { messageId: "message-1", receivedLength: 12, appliedLength: 12 };
    noteThreadStreamSnapshot("env", "thread", { sequence: 1, source: "http", reply });
    advance(5_000);
    noteThreadStreamEvents("env", "thread", events(2, { reply: [null, 12] }));
    expect(thread()?.reply).toMatchObject({
      receivedVia: "http snapshot",
      receivedLength: 12,
      receivedAt: 1_000,
      updatedVia: "event",
      updatedAt: 6_000,
    });
  });

  it("never drops the selected reply's row, and says when another row's was dropped", () => {
    const { report } = setup();
    noteThreadStreamEvents("env", "thread", events(1, { reply: [5, 5] }));
    noteThreadFeedReplyRow("env", "thread", "message-1", { length: 5, visible: true });
    noteThreadFeedReplyRow("env", "thread", "early", { length: 2, visible: false });
    for (let index = 0; index < 12; index += 1)
      noteThreadFeedReplyRow("env", "thread", `other-${index}`, { length: 1, visible: false });
    expect(report()).toContain("row committed 5");

    noteThreadStreamEvents("env", "thread", {
      ...events(2),
      reply: { messageId: "early", receivedLength: 2, appliedLength: 2 },
    });
    expect(report()).toContain("row observation no longer kept");

    for (let index = 0; index < 20; index += 1)
      noteThreadFeedReplyRow("env", "thread", `later-${index}`, { length: 1, visible: false });
    noteThreadStreamEvents("env", "thread", {
      ...events(3),
      reply: { messageId: "never-recorded", receivedLength: 1, appliedLength: 1 },
    });
    // Eviction history overflowed, so an unseen row may still have been committed.
    expect(report()).toContain("row observation no longer kept");
  });

  it("marks the tracked reply missing from state when a snapshot without it replaces the state", () => {
    const { thread } = setup();
    noteThreadStreamEvents("env", "thread", events(1, { reply: [9, 9] }));
    noteThreadStreamSnapshot("env", "thread", { sequence: 2, source: "socket", reply: null });
    expect(thread()?.reply).toMatchObject({
      receivedLength: 9,
      appliedLength: null,
      updatedVia: "socket snapshot",
    });
  });

  it("reports a row committed before its reply was selected", () => {
    const { report } = setup();
    noteThreadFeedReplyRow("env", "thread", "message-1", { length: 12, visible: true });
    noteThreadStreamEvents("env", "thread", events(1, { reply: [12, 12] }));
    expect(report()).toContain("row committed 12 at 00:00:01 UTC, on screen");
  });

  it("looks for the reply only among the newest rows", () => {
    const row = (index: number, messageId: string) => ({
      item: { type: "assistant_message", messageId, text: "x".repeat(index) },
    });
    const projection = {
      visibleTurnItems: [row(3, "deep"), ...Array.from({ length: 100 }, (_, i) => row(i, `m${i}`))],
    } as unknown as Parameters<typeof replyProgress>[1];
    const message = (id: string) =>
      ({
        event: { type: "message.updated", payload: { id, role: "assistant", text: "abc" } },
      }) as unknown as Parameters<typeof replyProgress>[0][number];
    expect(replyProgress([message("m99")], projection)?.appliedLength).toBe(99);
    expect(replyProgress([message("deep")], projection)).toMatchObject({
      receivedLength: 3,
      appliedLength: null,
    });
  });

  it("tracks a reply that only a snapshot delivered, and a row that left the list", () => {
    const { thread, report, advance } = setup();
    const reply = { messageId: "message-1", receivedLength: 7, appliedLength: 7 };
    noteThreadStreamSnapshot("env", "thread", { sequence: 3, source: "socket", reply });
    noteThreadFeedReplyRow("env", "thread", "message-1", { length: 7, visible: true });
    expect(thread()?.reply?.receivedVia).toBe("socket snapshot");
    advance(2_000);
    noteThreadFeedReplyRow("env", "thread", "message-1", null);
    expect(report()).toContain(
      "row committed 7 at 00:00:01 UTC, on screen, unmounted at 00:00:03 UTC",
    );
  });

  it("keeps error text out of the report", () => {
    const { thread, report } = setup();
    noteThreadStreamStatus("env", "thread", "cached", true);
    expect(thread()?.hasError).toBe(true);
    expect(report()).toContain("status: cached with error");
  });

  it("starts a reopened thread fresh and as the most recent entry", () => {
    const { thread, advance } = setup();
    noteThreadStreamEvents("env", "thread", events(3, { reply: [5, 5] }));
    noteThreadStreamClosed("env", "thread");
    for (let index = 0; index < 19; index += 1) noteThreadStreamOpened("env", `other-${index}`);
    advance(1_000);
    noteThreadStreamOpened("env", "thread");
    noteThreadStreamOpened("env", "newest");
    const threads = readThreadStreamDiagnostics();
    expect(threads).toHaveLength(20);
    expect(threads[1]).toMatchObject({
      threadId: "thread",
      reply: null,
      closedAt: null,
      openedAt: 2_000,
    });
    expect(threads.some((entry) => entry.threadId === "other-0")).toBe(false);
    expect(thread()?.threadId).toBe("newest");
  });

  it("notifies only a subscribed screen", () => {
    setup();
    let notified = 0;
    const unsubscribe = subscribeThreadStreamDiagnostics(() => {
      notified += 1;
    });
    noteThreadStreamEvents("env", "thread", events(1));
    unsubscribe();
    noteThreadStreamEvents("env", "thread", events(2));
    expect(notified).toBe(1);
  });
});
