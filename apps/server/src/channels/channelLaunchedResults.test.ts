import { MessageId, RunId, ThreadId, type OrchestrationV2Run } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import { launchedResultOwed, type LaunchedEnd } from "./channelLaunchedResults.ts";

const session = ThreadId.make("goat-bot-session:s");
const child = ThreadId.make("channel-child-work:c");
const endIso = "2026-11-07T11:52:07.000Z";
const runId = RunId.make("run:c:1");

const wakeId = (event: string, launcher: string = session, host = "", thread: string = child) =>
  "message:launch-watch:" +
  [launcher, host, thread].map(encodeURIComponent).join(":") +
  ":" +
  event;

const ownRun = (messageId: string) =>
  ({ id: RunId.make("wake"), userMessageId: MessageId.make(messageId) }) as OrchestrationV2Run;

const end = (overrides: Partial<LaunchedEnd> = {}): LaunchedEnd => ({
  launcherThreadId: session,
  childThreadId: child,
  runId,
  endIso,
  watch: { detached: false, skippedRuns: [], reportedEnds: {} },
  ...overrides,
});

describe("launchedResultOwed", () => {
  it("is owed until the task's own runs hold the wake for the child's end", () => {
    expect(launchedResultOwed(end(), [])).toBe(true);
    expect(launchedResultOwed(end(), [ownRun(wakeId("run:run:c:1"))])).toBe(false);
    // A retried attempt's wake carries the attempt; it reports the same end.
    expect(launchedResultOwed(end(), [ownRun(wakeId("run:run:c:1") + ":attempt-2")])).toBe(false);
  });

  it("does not take another run, launcher, host, thread or event's wake for this end", () => {
    for (const other of [
      wakeId("run:run:c:12"),
      wakeId("run:run:c"),
      wakeId("run:run:c:1", "goat-bot-session:other"),
      wakeId("run:run:c:1", session, "mini"),
      wakeId("run:run:c:1", session, "", "channel-child-work:other"),
      wakeId("question:run:c:1:q1"),
      "message:run:c:1",
    ])
      expect(launchedResultOwed(end(), [ownRun(other)])).toBe(true);
  });

  it("matches a later end of a run retried in place by its end, never by time", () => {
    const retried = end({
      endIso: "2026-11-07T11:55:00.000Z",
      watch: { detached: false, skippedRuns: [], reportedEnds: { [runId]: endIso } },
    });
    // The first end's wake does not cover the retry's end, whatever its time.
    expect(launchedResultOwed(retried, [ownRun(wakeId("run:run:c:1"))])).toBe(true);
    expect(launchedResultOwed(retried, [ownRun(wakeId("run:run:c:1:end:" + endIso))])).toBe(true);
    expect(
      launchedResultOwed(retried, [ownRun(wakeId("run:run:c:1:end:2026-11-07T11:55:00.000Z"))]),
    ).toBe(false);
    // A first end the watch recorded as this very end is covered by the first wake.
    const first = end({
      watch: { detached: false, skippedRuns: [], reportedEnds: { [runId]: endIso } },
    });
    expect(launchedResultOwed(first, [ownRun(wakeId("run:run:c:1"))])).toBe(false);
    // An end that could not be read takes any wake for the run.
    expect(
      launchedResultOwed(end({ endIso: null }), [ownRun(wakeId("run:run:c:1:end:unknown:1"))]),
    ).toBe(false);
  });

  it("is not owed when no wake is coming: no watch, an unwatched one, or a run the child went on from", () => {
    expect(launchedResultOwed(end({ watch: null }), [])).toBe(false);
    expect(
      launchedResultOwed(end({ watch: { detached: true, skippedRuns: [], reportedEnds: {} } }), []),
    ).toBe(false);
    expect(
      launchedResultOwed(
        end({ watch: { detached: false, skippedRuns: [runId], reportedEnds: {} } }),
        [],
      ),
    ).toBe(false);
  });

  it("stays owed when the watch could not be read", () => {
    expect(launchedResultOwed(end({ watch: "unreadable" }), [])).toBe(true);
    expect(launchedResultOwed(end({ watch: "unreadable" }), [ownRun(wakeId("run:run:c:1"))])).toBe(
      false,
    );
  });
  it("stays owed for a wake on the launcher that is not one of the task's runs, watched or not", () => {
    const unowned = ownRun(wakeId("run:run:c:1"));
    expect(launchedResultOwed(end(), [], [unowned])).toBe(true);
    expect(launchedResultOwed(end({ watch: null }), [], [unowned])).toBe(true);
  });
});
