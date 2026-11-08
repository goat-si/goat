import { assert, describe, it } from "@effect/vitest";
import { ChannelTaskEventId, type ThreadResultReport } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import * as ChannelWorkerReports from "./ChannelWorkerReports.ts";
import { commitTransition } from "./channelTaskWrites.ts";
import { REMOTE_SETTLE_WAIT_MS } from "./ChannelRemoteWorkers.ts";
import {
  RemoteMachine,
  correlationOf,
  remoteScript,
  settle,
  until,
} from "./testing/RemoteMachine.ts";
import {
  goatInput,
  makeHarness,
  onlyTask,
  rpcContext,
  setupBot,
} from "./testkit/ChannelHarness.ts";

const ASKED = Date.parse("2026-10-12T00:00:00.000Z");

/** A worker that asked the person a question; its run is still going. */
const askedTask = Effect.gen(function* () {
  yield* TestClock.setTime(ASKED);
  yield* setupBot;
  const gateway = yield* ChannelGateway.ChannelGateway;
  const runtime = yield* ChannelRuntime.ChannelRuntime;
  const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
  yield* gateway.ingest(goatInput("do: tidy the notes file", "asked"), rpcContext);
  yield* runtime.drain;
  const task = yield* onlyTask;
  yield* reports.report(
    {
      taskId: task.taskId,
      eventId: ChannelTaskEventId.make("asked-question"),
      generation: task.generation,
      status: "waiting_input",
      summary: "Which file?",
      question: "Which notes file?",
    },
    task.worker!.threadId,
  );
  return { task, threadId: task.worker!.threadId, runtime };
});

// The row goat_thread_report_result writes, at the time it was reported.
const storeReport = (
  harness: ReturnType<typeof makeHarness>,
  threadId: string,
  report: ThreadResultReport,
  reportedAt: string,
) =>
  Effect.gen(function* () {
    const run = harness.world.latestRun(threadId as never)!;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO thread_run_results (thread_id, run_id, report_json, reported_at)
      VALUES (${threadId}, ${run.id}, ${JSON.stringify(report)}, ${reportedAt})
    `;
  });

const provide = (harness: ReturnType<typeof makeHarness>) =>
  Effect.provide(harness.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)));

describe("a worker's outcome after it asked the person", () => {
  it.effect.each(["failed", "cancelled"] as const)(
    "a %s outcome reported after the question ends the task and closes the question",
    (outcome) => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const { threadId, runtime } = yield* askedTask;
        assert.strictEqual((yield* onlyTask).status, "waiting_input");
        yield* storeReport(
          harness,
          threadId,
          { outcome, summary: "There is no notes file to tidy." },
          "2026-10-12T00:01:00.000Z",
        );
        harness.world.setStatus(threadId, 1, "completed", "Stopping here.");
        yield* runtime.drain;
        const ended = yield* onlyTask;
        assert.strictEqual(ended.status, "failed");
        assert.strictEqual(ended.resultSummary, "There is no notes file to tidy.");
        assert.deepStrictEqual(ended.openQuestions, []);
      }).pipe(provide(harness));
    },
  );

  it.effect("a failure reported before the question leaves the task waiting for the answer", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const { threadId, runtime } = yield* askedTask;
      yield* storeReport(
        harness,
        threadId,
        { outcome: "failed", summary: "An earlier attempt failed." },
        "2026-10-11T23:59:00.000Z",
      );
      harness.world.setStatus(threadId, 1, "completed", "Which notes file?");
      yield* runtime.drain;
      const waiting = yield* onlyTask;
      assert.strictEqual(waiting.status, "waiting_input");
      assert.lengthOf(waiting.openQuestions, 1);
    }).pipe(provide(harness));
  });

  it.effect("a task stopped while it waits closes its question", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const { runtime } = yield* askedTask;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const waiting = (yield* ledger.getTask((yield* onlyTask).taskId))!;
      yield* commitTransition(
        ledger,
        waiting,
        { type: "task.cancelled", payload: { reason: "Stopped." } },
        { owner: runtime.ownerToken },
      );
      const stopped = yield* onlyTask;
      assert.strictEqual(stopped.status, "cancelled");
      assert.deepStrictEqual(stopped.openQuestions, []);
    }).pipe(provide(harness));
  });
});

describe("a worker on another machine that asked the person", () => {
  const remoteHarness = () => {
    const machine = new RemoteMachine();
    const harness = makeHarness({ sshRemote: machine.layer });
    harness.script.current = remoteScript;
    return { machine, harness };
  };

  /** A remote worker asks, then its run completes reporting a failure stamped `reportedAt`. */
  const askThenFail = (
    machine: RemoteMachine,
    reportedAt: (askedAt: DateTime.Utc) => string | undefined,
  ) =>
    Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      yield* gateway.ingest(goatInput("do@mac-studio: tidy the notes", "remote-asked"), rpcContext);
      yield* until("running", (task) => task.status === "running");
      const correlationId = correlationOf(machine);
      machine.report(correlationId, "needs_input", "Which notes file?");
      const asked = yield* until("question", (task) => task.status === "waiting_input");
      const at = reportedAt(DateTime.makeUnsafe(asked.openQuestions[0]!.askedAt));
      machine.finishRun(correlationId, "completed", "Stopping here.", {
        outcome: "failed",
        summary: "There is no notes file to tidy.",
        ...(at === undefined ? {} : { reportedAt: at }),
      });
    });

  it.effect("ends the task once nothing holds the run, and closes the question", () => {
    const { machine, harness } = remoteHarness();
    machine.setHolds({ backgroundTasks: 0, continuationPending: true });
    return Effect.gen(function* () {
      yield* askThenFail(machine, (askedAt) =>
        DateTime.formatIso(DateTime.add(askedAt, { minutes: 1 })),
      );
      // A continuation still to come keeps the task open, as for a finished run.
      yield* TestClock.adjust(Duration.millis(REMOTE_SETTLE_WAIT_MS * 2));
      yield* settle();
      assert.strictEqual((yield* onlyTask).status, "waiting_input");
      machine.setHolds({ backgroundTasks: 0, continuationPending: false });
      const ended = yield* until("failed", (task) => task.status === "failed", 400);
      assert.strictEqual(ended.resultSummary, "There is no notes file to tidy.");
      assert.deepStrictEqual(ended.openQuestions, []);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("keeps waiting when an older remote sends no report time", () => {
    const { machine, harness } = remoteHarness();
    return Effect.gen(function* () {
      yield* askThenFail(machine, () => undefined);
      yield* TestClock.adjust(Duration.millis(REMOTE_SETTLE_WAIT_MS * 2));
      yield* settle();
      const waiting = yield* onlyTask;
      assert.strictEqual(waiting.status, "waiting_input");
      assert.lengthOf(waiting.openQuestions, 1);
    }).pipe(Effect.provide(harness.layer));
  });
});
