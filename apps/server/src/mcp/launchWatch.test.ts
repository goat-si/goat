import { expect, it } from "@effect/vitest";
import { RunId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  addPendingRun,
  discoverRun,
  endReported,
  finishedWake,
  LaunchWatchDocument,
  launchWatchId,
  newLaunchWatch,
  normalizeHost,
  outageWake,
  questionWake,
  quietEnd,
  rearmRetriedRun,
  recordContact,
  recordFailure,
  settleEnd,
  settleRun,
} from "./launchWatch.ts";

const makeWatch = (host: string | null = "box") =>
  newLaunchWatch({
    launcherThreadId: ThreadId.make("caller"),
    host,
    threadId: ThreadId.make("target-thread"),
    projectId: null,
    title: "Audit",
    incarnation: "watch-incarnation",
    notifyWebhook: false,
    now: 0,
  });

it("reads watches saved before completion webhooks with the webhook off", () => {
  const { notifyWebhook: _added, ...saved } = makeWatch();
  const document = Schema.decodeUnknownSync(LaunchWatchDocument)({
    version: 1,
    watches: [saved],
  });
  expect(document.watches[0]?.notifyWebhook).toBe(false);
});

it("gives a retried run's end new ids when an earlier server reported its first end (#978)", () => {
  const run = RunId.make("run-1");
  const {
    reportedEnds: _added,
    followAgain: _alsoAdded,
    ...saved
  } = settleRun(addPendingRun(makeWatch(), run, 0), run, 0);
  const [upgraded] = Schema.decodeUnknownSync(LaunchWatchDocument)({
    version: 1,
    watches: [saved],
  }).watches;
  const wake = (watch: typeof upgraded) =>
    finishedWake({
      watch: watch!,
      runId: run,
      status: "completed",
      title: null,
      branch: null,
      worktreePath: null,
      excerpt: null,
      end: "2026-10-24T00:00:00.000Z",
    });
  const reported = wake(upgraded);
  const retried = wake(rearmRetriedRun(upgraded!, run, 1));
  expect(retried.commandId).not.toBe(reported.commandId);
  expect(retried.messageId).not.toBe(reported.messageId);
});

it("reports each end it could not read, under ids of its own", () => {
  const run = RunId.make("run-1");
  const wake = (watch: ReturnType<typeof makeWatch>) =>
    finishedWake({
      watch,
      runId: run,
      status: "failed",
      title: null,
      branch: null,
      worktreePath: null,
      excerpt: null,
      end: null,
    });
  const first = addPendingRun(makeWatch(), run, 0);
  const second = rearmRetriedRun(settleEnd(first, run, null, 0), run, 1);
  const third = rearmRetriedRun(settleEnd(second, run, null, 1), run, 2);
  expect(endReported(second, run, null)).toBe(false);
  const ids = [first, second, third].map((watch) => wake(watch).commandId);
  expect(new Set(ids).size).toBe(3);
});

it.effect("notifies once on the third failure and caps contact backoff at fifteen minutes", () =>
  Effect.sync(() => {
    let watch = makeWatch();
    const notifications: Array<boolean> = [];
    const delays: Array<number> = [];
    for (let failure = 1; failure <= 8; failure++) {
      const now = failure * 1_000;
      const result = recordFailure(watch, now, "SSH unavailable");
      watch = result.next;
      notifications.push(result.notify);
      delays.push((watch.outage?.nextRetryAt ?? now) - now);
    }
    expect(notifications).toEqual([false, false, true, false, false, false, false, false]);
    expect(delays).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000, 900_000]);
    expect(watch.outage).toMatchObject({ since: 1_000, episode: 1, failures: 8, notified: true });
  }),
);

it.effect("successful contact ends an outage and gives the next episode a distinct wake", () =>
  Effect.sync(() => {
    let watch = makeWatch();
    for (let failure = 1; failure <= 3; failure++) {
      watch = recordFailure(watch, failure, "offline").next;
    }
    const firstOutage = watch.outage!;
    const firstWake = outageWake({ watch, outage: firstOutage });
    watch = recordContact(watch, 4);
    expect(watch.outage).toBeNull();
    expect(watch.lastEpisode).toBe(1);
    const firstFailure = recordFailure(watch, 5, "offline again");
    expect(firstFailure.notify).toBe(false);
    expect(firstFailure.next.outage).toMatchObject({ episode: 2, failures: 1, since: 5 });
    watch = firstFailure.next;
    expect(recordFailure(watch, 6, "offline again").notify).toBe(false);
    watch = recordFailure(watch, 6, "offline again").next;
    const thirdFailure = recordFailure(watch, 7, "offline again");
    expect(thirdFailure.notify).toBe(true);
    const nextWake = outageWake({ watch: thirdFailure.next, outage: thirdFailure.next.outage! });
    expect(nextWake.commandId).not.toBe(firstWake.commandId);
  }),
);

it.effect("does not enqueue a pending or previously reported run twice", () =>
  Effect.sync(() => {
    const runId = RunId.make("run-1");
    const pending = addPendingRun(makeWatch(), runId, 1);
    const repeated = addPendingRun(pending, runId, 2);
    expect(repeated.pendingRuns).toEqual([runId]);
    const settled = settleRun(repeated, runId, 3);
    expect(settled.pendingRuns).toEqual([]);
    expect(settled.reportedRuns).toEqual([runId]);
    const reportedAgain = addPendingRun(settled, runId, 4);
    expect(reportedAgain.pendingRuns).toEqual([]);
    expect(reportedAgain.reportedRuns).toEqual([runId]);
  }),
);

it.effect("keeps the twenty most recent settled runs without disturbing other pending runs", () =>
  Effect.sync(() => {
    const stillRunning = RunId.make("still-running");
    let watch = addPendingRun(makeWatch(), stillRunning, 1);
    const runs = Array.from({ length: 21 }, (_, index) => RunId.make(`run-${index}`));
    for (const runId of runs) {
      watch = settleRun(addPendingRun(watch, runId, 2), runId, 3);
    }
    expect(watch.pendingRuns).toEqual([stillRunning]);
    expect(watch.reportedRuns).toEqual(runs.slice(1));
  }),
);

const finish = (watch = makeWatch(), runId = RunId.make("run-1")) =>
  finishedWake({
    watch,
    runId,
    status: "rolled_back",
    title: null,
    branch: null,
    worktreePath: null,
    excerpt: null,
  });

it.effect("completion messages identify the environment and preserve rolled-back status", () =>
  Effect.sync(() => {
    for (const host of [null, "box"]) {
      const wake = finish(makeWatch(host));
      expect(wake.text).toContain("threadId target-thread");
      expect(wake.text).toContain(host === null ? "this environment" : "host box");
      expect(wake.text).toContain("status rolled_back");
      expect(wake.notification.outcome).toBe("cancelled");
    }
  }),
);

it.effect(
  "a run-end wake quotes the start of a long last message and points to the thread for the rest",
  () =>
    Effect.sync(() => {
      const watch = makeWatch("box");
      const excerpt = Array.from(
        { length: 30 },
        (_, line) => `line ${line} ${"x".repeat(60)}`,
      ).join("\n");
      const wake = finishedWake({
        watch,
        runId: RunId.make("run-1"),
        status: "completed",
        title: "Long title ".repeat(30),
        branch: null,
        worktreePath: null,
        excerpt,
      });
      const quoted = wake.text.split("Last message:\n")[1]!.split("\nThe message continues")[0]!;
      expect(quoted.split("\n").length).toBeLessThanOrEqual(4);
      expect(quoted.length).toBeLessThanOrEqual(400);
      expect(wake.text).not.toContain("line 5 ");
      expect(wake.text).toContain(
        'The message continues; read it with goat_call {path: "thread.read", args: {threadId: "target-thread", host: "box"}}.',
      );
      // The client shows a longer detail than the agent reads.
      expect(wake.notification.detail!.length).toBeLessThanOrEqual(1_500);
      expect(wake.notification.detail!.length).toBeGreaterThan(quoted.length);
      expect(wake.notification.summary.length).toBeLessThanOrEqual(120);
      expect(wake.commandId).toBe(finish(watch).commandId);
      expect(wake.commandId).not.toBe(finish(watch, RunId.make("run-2")).commandId);
    }),
);

it.effect("a short last message is quoted whole", () =>
  Effect.sync(() => {
    const wake = finishedWake({
      watch: makeWatch(null),
      runId: RunId.make("run-1"),
      status: "completed",
      title: null,
      branch: null,
      worktreePath: null,
      excerpt: "Fixed the flake; tests pass.",
    });
    expect(wake.text).toContain(
      "Last message:\nFixed the flake; tests pass.\nRead the thread with",
    );
    expect(wake.text).not.toContain("continues");
  }),
);

it.effect("question messages give concrete local and remote pending-tool arguments", () =>
  Effect.sync(() => {
    const question = (host: string | null) =>
      questionWake({
        watch: makeWatch(host),
        runId: RunId.make("run-1"),
        requestId: "request-1",
        kind: "user_input",
        title: null,
      });
    expect(question(null).text).toContain(
      'goat_call {path: "pending_request.read", args: {threadId: "target-thread", requestId: "request-1"}}',
    );
    expect(question("box").text).toContain(
      'goat_call {path: "pending_request.read", args: {host: "box", threadId: "target-thread", requestId: "request-1"}}',
    );
    expect(question("box").text).toContain(
      'goat_call {path: "pending_request.respond", args: {host, threadId, requestId, reason}}',
    );
    expect(question("box").text).toContain("forward it to the user");
    for (const host of [null, "box"]) {
      for (const kind of [null, "command"]) {
        const wake = questionWake({
          watch: makeWatch(host),
          runId: RunId.make("run-1"),
          requestId: "request-1",
          kind,
          title: null,
        });
        expect(wake.text).not.toContain("pending_request.respond");
        expect(wake.text).toContain(kind === null ? "a request" : "a command request");
        if (host !== null) expect(wake.text).toContain("from a client connected to box");
      }
    }
  }),
);

it.effect("normalizes blank hosts and distinguishes local watches from remote watches", () =>
  Effect.sync(() => {
    expect(normalizeHost("  box \n")).toBe("box");
    for (const host of ["", " \t\n", null, undefined]) {
      expect(normalizeHost(host)).toBeNull();
    }
    const target = { launcherThreadId: "caller", threadId: "target-thread" };
    expect(launchWatchId({ ...target, host: null })).not.toBe(
      launchWatchId({ ...target, host: "box" }),
    );
  }),
);

it("follows a run the thread started itself once, and counts finding it as arming the watch", () => {
  const run1 = RunId.make("run-1");
  const run2 = RunId.make("run-2");
  const reported = settleEnd(addPendingRun(makeWatch(), run1, 0), run1, "end-1", 10);
  const found = discoverRun(reported, run2, 500);
  expect(found).toMatchObject({ pendingRuns: [run2], discoveredRuns: [run2], armedAt: 500 });
  // Seeing the same run, or one already reported, again changes nothing.
  expect(discoverRun(found, run2, 900)).toBe(found);
  expect(discoverRun(reported, run1, 900)).toBe(reported);
  // Its end settles it like any other run, so it is never reported twice.
  const ended = settleEnd(found, run2, "end-2", 600);
  expect(ended).toMatchObject({ pendingRuns: [], discoveredRuns: [], reportedRuns: [run1, run2] });
  expect(discoverRun(ended, run2, 900)).toBe(ended);
});

it("makes a found run owed once its caller sends into it or retries it", () => {
  const run = RunId.make("run-2");
  const found = discoverRun(makeWatch(), run, 0);
  expect(addPendingRun(found, run, 5)).toMatchObject({ pendingRuns: [run], discoveredRuns: [] });
  expect(rearmRetriedRun(found, run, 5)).toMatchObject({
    pendingRuns: [run],
    followAgain: [run],
    discoveredRuns: [],
  });
});

it("settles a found run's end unreported when the thread went on, a send started it, or it echoes", () => {
  const run = RunId.make("run-2");
  const watch = makeWatch(null);
  const found = discoverRun(watch, run, 0);
  const quiet = (trigger: string | null, continuedIn: RunId | null = null) =>
    quietEnd(found, run, { trigger, continuedIn });
  // The thread is reported once it goes idle, not for each short wake on the way.
  expect(quiet(null, RunId.make("run-3"))).toBe("continued");
  // Another caller's goat_thread_send reports to that caller's own watch.
  expect(quiet("message:mcp:client%3Abot-b:thread-send:request-1")).toBe("sent");
  // The launcher's own report about this thread woke it: reporting that back would loop.
  const echo = launchWatchId({ launcherThreadId: watch.threadId, host: "mac", threadId: "caller" });
  expect(quiet(`message:launch-watch:${echo}:run:run-9`)).toBe("echo");
  // Wakes from anything else, typed messages, and unknown starts are the thread's own work.
  const other = launchWatchId({ launcherThreadId: watch.threadId, host: null, threadId: "child" });
  expect(quiet(`message:launch-watch:${other}:run:run-9`)).toBeNull();
  expect(quiet("message:mcp:goat-thread:origin-report:1")).toBeNull();
  expect(quiet(null)).toBeNull();
  expect(quiet(null, run)).toBeNull();
  // A run the watch was armed for is always reported.
  const armed = addPendingRun(watch, run, 0);
  expect(quietEnd(armed, run, { trigger: null, continuedIn: RunId.make("run-3") })).toBeNull();
  expect(
    quietEnd(armed, run, { trigger: "message:mcp:client:thread-send:1", continuedIn: null }),
  ).toBeNull();
});
