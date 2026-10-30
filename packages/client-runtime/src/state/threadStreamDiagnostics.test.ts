import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  formatThreadStreamReport,
  noteThreadFeedRendered,
  noteThreadStreamClosed,
  noteThreadStreamEvents,
  noteThreadStreamOpened,
  noteThreadStreamSnapshot,
  noteThreadStreamSubscribed,
  readThreadStreamDiagnostics,
  resetThreadStreamDiagnosticsForTest,
  subscribeThreadStreamDiagnostics,
} from "./threadStreamDiagnostics.ts";

const event = (sequence: number, itemOrdinal: number | null = null) => ({
  count: 1,
  sequence,
  eventType: itemOrdinal === null ? "thread.updated" : "turn-item.updated",
  itemOrdinal,
  visibleItems: 3,
  status: "live",
  error: null,
});

describe("thread stream diagnostics", () => {
  let now = 0;
  beforeEach(() => {
    now = 1_000;
    resetThreadStreamDiagnosticsForTest(() => now);
  });

  it("names how each subscription restarted: a snapshot reload or an event replay", () => {
    noteThreadStreamOpened("env", "thread");
    noteThreadStreamSubscribed("env", "thread", null);
    noteThreadStreamSnapshot("env", "thread", 5, 2);
    expect(readThreadStreamDiagnostics()[0]).toMatchObject({
      subscriptions: 1,
      lastStart: "snapshot",
    });

    noteThreadStreamSubscribed("env", "thread", 5);
    noteThreadStreamEvents("env", "thread", event(6, 4));
    noteThreadStreamEvents("env", "thread", event(7));
    expect(readThreadStreamDiagnostics()[0]).toMatchObject({
      subscriptions: 2,
      lastStart: "replay",
      events: 2,
      lastSequence: 7,
      latestItemOrdinal: 4,
      lastEventType: "thread.updated",
    });
  });

  it("separates a stalled list from a stalled stream in the copied report", () => {
    noteThreadStreamOpened("env", "thread");
    noteThreadStreamSubscribed("env", "thread", null);
    noteThreadStreamEvents("env", "thread", event(9, 12));
    noteThreadFeedRendered("env", "thread", 1);
    const report = formatThreadStreamReport(readThreadStreamDiagnostics());
    expect(report).toContain("events: 1, last #9 turn-item.updated at 00:00:01 UTC");
    expect(report).toContain("visible items: 3, feed rows drawn: 1 at 00:00:01 UTC");
    expect(report).toContain("subscriptions: 1, last 00:00:01 UTC, started by replay");
  });

  it("keeps a bounded number of threads and transitions", () => {
    for (let index = 0; index < 25; index += 1) noteThreadStreamOpened("env", `thread-${index}`);
    const threads = readThreadStreamDiagnostics();
    expect(threads).toHaveLength(20);
    expect(threads[0]?.threadId).toBe("thread-24");
    expect(threads.at(-1)?.threadId).toBe("thread-5");

    for (let index = 0; index < 30; index += 1)
      noteThreadStreamSubscribed("env", "thread-24", index);
    expect(readThreadStreamDiagnostics()[0]?.transitions).toHaveLength(12);
  });

  it("notifies an open screen and keeps a closed thread readable", () => {
    let notified = 0;
    const unsubscribe = subscribeThreadStreamDiagnostics(() => {
      notified += 1;
    });
    noteThreadStreamOpened("env", "thread");
    noteThreadStreamEvents("env", "thread", event(1));
    noteThreadStreamClosed("env", "thread");
    unsubscribe();
    noteThreadStreamEvents("env", "thread", event(2));
    expect(notified).toBe(3);
    expect(readThreadStreamDiagnostics()[0]).toMatchObject({ closedAt: 1_000, lastSequence: 2 });
  });
});
