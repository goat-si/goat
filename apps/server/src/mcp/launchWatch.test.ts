import { expect, it } from "@effect/vitest";
import { RunId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  addPendingRun,
  finishedWake,
  LaunchWatchDocument,
  launchWatchId,
  newLaunchWatch,
  normalizeHost,
  outageWake,
  questionWake,
  recordContact,
  recordFailure,
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
      "pending_request.respond using the same host, threadId, and requestId (reason required)",
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
