import { assert, describe, it } from "@effect/vitest";
import { ChannelTaskEvent, type ThreadResultObservedCheck } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import * as ChannelWorkerReports from "./ChannelWorkerReports.ts";
import {
  botMessages,
  linkSlackUser,
  makeHarness,
  onlyTask,
  resultsTo,
  setupBot,
  slackContext,
  slackInput,
} from "./testkit/ChannelHarness.ts";

const check: ThreadResultObservedCheck = {
  status: "completed",
  command: "vp test run",
  exitCode: 3,
  durationMs: 1250,
  at: "2026-10-12T00:00:00.000Z",
  outputTail: "one test failed",
};
const tests = { ok: true, command: "vp test run", passed: 12, failed: 0 };
const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(ChannelTaskEvent));

const events = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return (yield* sql<{
    event_json: string;
  }>`SELECT event_json FROM channel_task_events ORDER BY sequence`).map((row) =>
    decodeEvent(row.event_json),
  );
});

const start = (harness: ReturnType<typeof makeHarness>) =>
  Effect.gen(function* () {
    yield* setupBot;
    yield* linkSlackUser();
    const gateway = yield* ChannelGateway.ChannelGateway;
    const runtime = yield* ChannelRuntime.ChannelRuntime;
    yield* gateway.ingest(slackInput("do: verify the change", "observed-check"), slackContext);
    yield* runtime.drain;
    const task = yield* onlyTask;
    const threadId = task.worker!.threadId;
    const runId = harness.world.latestRun(threadId)!.id;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO thread_run_results (thread_id, run_id, report_json, reported_at)
    VALUES (${threadId}, ${runId}, ${JSON.stringify({ outcome: "succeeded", summary: "Done and verified.", tests })}, ${check.at})`;
    return { runtime, task, threadId, runId, sql };
  });

const storeCheck = (threadId: string, runId: string, status = check.status) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO thread_run_observed_checks (thread_id, run_id, status, command, exit_code, duration_ms, started_at, output_tail)
    VALUES (${threadId}, ${runId}, ${status}, ${check.command}, ${check.exitCode}, ${check.durationMs}, ${check.at}, ${check.outputTail ?? null})
    ON CONFLICT(thread_id, run_id) DO UPDATE SET status=excluded.status, exit_code=excluded.exit_code, duration_ms=excluded.duration_ms, output_tail=excluded.output_tail`;
  });

describe("channel check evidence", () => {
  it.effect(
    "retains a failing observed check beside reported success without changing completion",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const { runtime, threadId, runId } = yield* start(harness);
        yield* storeCheck(threadId, runId);
        harness.world.setStatus(threadId, 1, "completed", "Done.");
        yield* runtime.drain;
        const done = yield* onlyTask;
        assert.strictEqual(done.status, "completed");
        assert.strictEqual(done.completionReport, "present");
        assert.deepStrictEqual(done.observed?.result, {
          runId,
          tests,
          observedCheck: check,
          observedCheckPending: false,
        });
        assert.include(
          resultsTo(harness.slackSent, "result")[0]!.message.text,
          "Verification: the agent reported tests passed; GOAT's own check failed (exit 3).",
        );
        const records = yield* botMessages;
        assert.deepStrictEqual(
          records.turnItems
            .flatMap((item) =>
              item.type === "notification" && item.ledgerTask ? [item.ledgerTask] : [],
            )
            .at(-1)?.observed?.result,
          done.observed?.result,
        );
        assert.lengthOf(
          (yield* events).filter((event) => event.type === "task.completed"),
          1,
        );
      }).pipe(
        Effect.provide(harness.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))),
      );
    },
  );

  it.effect(
    "attaches a delayed final check after service restart, once, without resettling",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const { runtime, threadId, runId } = yield* start(harness);
        const release = yield* Deferred.make<void>();
        const producer = yield* Deferred.await(release).pipe(
          Effect.andThen(storeCheck(threadId, runId)),
          Effect.forkChild,
        );
        harness.world.setStatus(threadId, 1, "completed", "Done.");
        yield* runtime.drain;
        const before = yield* onlyTask;
        assert.strictEqual(before.status, "completed");
        assert.isUndefined(before.observed?.result?.observedCheck);
        assert.strictEqual(before.observed?.result?.observedCheckPending, true);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(producer);
        // A fresh service recovers from SQL alone; no completion event or in-memory subscription.
        const restarted = yield* ChannelWorkerReports.ChannelWorkerReports.pipe(
          Effect.provide(ChannelWorkerReports.layer),
        );
        assert.strictEqual(yield* restarted.reconcile(runtime.ownerToken), 1);
        yield* runtime.drain;
        const after = yield* onlyTask;
        assert.strictEqual(after.status, before.status);
        assert.strictEqual(after.completedAt, before.completedAt);
        assert.strictEqual(after.resultSummary, before.resultSummary);
        assert.strictEqual(after.completionReport, before.completionReport);
        assert.deepStrictEqual(after.observed?.result?.tests, tests);
        assert.deepStrictEqual(after.observed?.result?.observedCheck, check);
        assert.strictEqual(yield* restarted.reconcile(runtime.ownerToken), 0);
        assert.strictEqual((yield* onlyTask).version, after.version);
        assert.lengthOf(
          (yield* events).filter((event) => event.type === "task.completed"),
          1,
        );
        assert.lengthOf(resultsTo(harness.slackSent, "result"), 1);
        assert.lengthOf(
          harness.slackSent.filter((delivery) =>
            delivery.message.text.startsWith("Verification for "),
          ),
          1,
        );
        const ledger = yield* ChannelLedger.ChannelLedger;
        assert.deepStrictEqual(
          (yield* ledger.getTask(after.taskId))?.task.observed?.result,
          after.observed?.result,
        );
      }).pipe(
        Effect.provide(harness.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))),
      );
    },
  );

  it.effect(
    "clears an observed running check when the producer resolves that no script ran",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const { runtime, threadId, runId, sql } = yield* start(harness);
        yield* storeCheck(threadId, runId, "running");
        harness.world.setStatus(threadId, 1, "completed", "Done.");
        yield* runtime.drain;
        const before = yield* onlyTask;
        assert.strictEqual(before.observed?.result?.observedCheck?.status, "running");
        yield* sql`UPDATE thread_run_observed_checks SET status = 'not_run' WHERE thread_id = ${threadId} AND run_id = ${runId}`;
        yield* runtime.drain;
        const after = yield* onlyTask;
        assert.deepStrictEqual(after.observed?.result, {
          runId,
          tests,
          observedCheckPending: false,
        });
        assert.strictEqual(after.status, "completed");
        assert.strictEqual(after.completedAt, before.completedAt);
        yield* runtime.drain;
        assert.strictEqual((yield* onlyTask).version, after.version);
      }).pipe(
        Effect.provide(harness.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))),
      );
    },
  );

  it.effect.each(["failed", "cancelled"] as const)(
    "settles a %s run even when its stored report cannot be decoded",
    (status) => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        const { runtime, threadId, runId, sql } = yield* start(harness);
        yield* sql`UPDATE thread_run_results SET report_json = 'invalid JSON' WHERE thread_id = ${threadId} AND run_id = ${runId}`;
        harness.world.setStatus(threadId, 1, status, "Stopped.");
        yield* runtime.drain;
        assert.strictEqual((yield* onlyTask).status, status);
        const terminalEvents = (yield* events).filter(
          (event) => event.type === "task.failed" || event.type === "task.cancelled",
        );
        assert.lengthOf(terminalEvents, 1);
        yield* runtime.drain;
        assert.lengthOf(
          (yield* events).filter(
            (event) => event.type === "task.failed" || event.type === "task.cancelled",
          ),
          1,
        );
      }).pipe(
        Effect.provide(harness.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))),
      );
    },
  );

  it.effect("records no-check disposition without inventing a pass", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const { runtime, threadId, runId, sql } = yield* start(harness);
      harness.world.setStatus(threadId, 1, "completed", "Done.");
      yield* runtime.drain;
      yield* sql`INSERT INTO thread_run_observed_checks (thread_id, run_id, status, command, started_at)
        VALUES (${threadId}, ${runId}, 'not_run', '', ${check.at})`;
      yield* runtime.drain;
      const task = yield* onlyTask;
      assert.deepStrictEqual(task.observed?.result, { runId, tests, observedCheckPending: false });
      assert.strictEqual(task.status, "completed");
      const version = task.version;
      yield* runtime.drain;
      assert.strictEqual((yield* onlyTask).version, version);
    }).pipe(Effect.provide(harness.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))));
  });
});
