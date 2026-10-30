import { describe, expect, it } from "vite-plus/test";

import {
  formatThreadStreamReport,
  noteThreadFeedReplyDrawn,
  noteThreadStreamClosed,
  noteThreadStreamEvents,
  noteThreadStreamOpened,
  noteThreadStreamSnapshot,
  noteThreadStreamStatus,
  noteThreadStreamSubscribed,
  noteThreadStreamSynchronized,
  readThreadStreamDiagnostics,
  resetThreadStreamDiagnosticsForTest,
  subscribeThreadStreamDiagnostics,
} from "./threadStreamDiagnostics.ts";

const events = (
  sequence: number,
  options: { readonly unknown?: number; readonly reply?: [number, number | null] } = {},
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
  };
}

describe("thread stream diagnostics", () => {
  it("names how each subscription attempt started", () => {
    const { thread } = setup();
    noteThreadStreamSnapshot("env", "thread", { sequence: 4, source: "http" });
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
    expect(thread()?.lastStart).toBe("live events");
  });

  it("counts unknown events and the cursor they advance", () => {
    const { thread } = setup();
    noteThreadStreamSubscribed("env", "thread", { afterSequence: null, completionMarker: false });
    noteThreadStreamEvents("env", "thread", events(9, { unknown: 2 }));
    expect(thread()).toMatchObject({ liveEvents: 2, unknownEvents: 2, lastSequence: 9 });
  });

  it.each([
    { layer: "the client state", applied: 10, expected: "in state 10, drawn 10" },
    { layer: "the list", applied: 40, expected: "in state 40, drawn 10" },
  ])("shows a reply that grew on the socket but stalled at $layer", ({ applied, expected }) => {
    setup();
    noteThreadStreamEvents("env", "thread", events(1, { reply: [10, 10] }));
    noteThreadFeedReplyDrawn("env", "thread", "message-1", 10);
    noteThreadStreamEvents("env", "thread", events(2, { reply: [40, applied] }));
    const report = formatThreadStreamReport(readThreadStreamDiagnostics());
    expect(report).toContain("latest reply message-1: received 40 chars");
    expect(report).toContain(expected);
  });

  it("keeps error text out of the report", () => {
    const { thread } = setup();
    noteThreadStreamStatus("env", "thread", "cached", true);
    const report = formatThreadStreamReport(readThreadStreamDiagnostics());
    expect(thread()?.hasError).toBe(true);
    expect(report).toContain("status: cached with error");
    expect(Object.values(thread() ?? {})).not.toContain("Could not synchronize the thread.");
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
