import { assert, describe, it } from "@effect/vitest";
import {
  ChannelTaskEvent,
  MessageId,
  SlackChannelConnectionId,
  type ChannelTask,
  type RunId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ReviewService from "../review/ReviewService.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelLayers from "./ChannelLayers.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import * as ChannelTaskReviews from "./ChannelTaskReviews.ts";
import * as SlackChannelSettings from "./SlackChannelSettings.ts";
import { commitTransition } from "./channelTaskWrites.ts";
import { reviewLaunchIdsFor } from "./channelIds.ts";
import {
  layerNoSshHosts,
  linkSlackUser,
  makeHarness,
  modelSelection,
  onlyTask,
  resultsTo,
  setupBot,
  slackContext,
  slackInput,
} from "./testkit/ChannelHarness.ts";

const reviewer = { ...modelSelection, model: "review-model" };
const now = "2026-10-12T00:00:00.000Z";
const pass = { verdict: "pass", summary: "No blockers found.", findings: [] };
const blockers = {
  verdict: "blockers",
  summary: "The guard is missing.",
  findings: [
    {
      kind: "decision",
      findingId: "guard",
      severity: "high",
      cites: "guard.ts:1",
      summary: "A stale report can complete fresh work.",
      decision: "accepted",
      evidence: { kind: "location", ref: "guard.ts:1" },
    },
  ],
};
const eventDecoder = Schema.decodeUnknownSync(Schema.fromJsonString(ChannelTaskEvent));
const events = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return (yield* sql<{
    event_json: string;
  }>`SELECT event_json FROM channel_task_events ORDER BY sequence`).map((row) =>
    eventDecoder(row.event_json),
  );
});

function harnessFor(enabled = true) {
  const channels = ChannelLayers.makeLayerServices(
    Layer.mock(SlackChannelSettings.SlackChannelSettings)({
      get: () =>
        Effect.succeed([
          {
            connectionId: SlackChannelConnectionId.make("slack-1"),
            enabled: true,
            hasAppToken: true,
            hasBotToken: true,
            allowedChannelIds: [],
            status: "connected",
            review: { enabled, modelSelection: reviewer },
          },
        ]),
      defaultTarget: () => Effect.succeed(Option.none()),
    }),
  ).pipe(
    Layer.provide(
      Layer.mock(ReviewService.ReviewService)({
        getDiffPreview: ({ cwd }) =>
          Effect.succeed({
            cwd,
            generatedAt: DateTime.makeUnsafe(now),
            sources: [
              {
                id: "working-tree",
                kind: "working-tree",
                title: "Working tree",
                baseRef: null,
                headRef: null,
                diff: "+guard\n",
                diffHash: "hash",
                truncated: false,
              },
            ],
          }),
      }),
    ),
  );
  return makeHarness({
    channelsLayer: channels,
    providerInstances: [
      {
        instanceId: modelSelection.instanceId,
        models: [{ slug: modelSelection.model }, { slug: reviewer.model }],
      },
    ],
  });
}
const report = (threadId: string, runId: RunId, summary: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO thread_run_results (thread_id, run_id, report_json, reported_at)
    VALUES (${threadId}, ${runId}, ${JSON.stringify({ outcome: "succeeded", summary })}, ${now})`;
  });
const start = (
  harness: ReturnType<typeof harnessFor>,
  beforeComplete?: (task: ChannelTask) => void,
) =>
  Effect.gen(function* () {
    yield* setupBot;
    yield* linkSlackUser();
    const gateway = yield* ChannelGateway.ChannelGateway;
    const runtime = yield* ChannelRuntime.ChannelRuntime;
    yield* gateway.ingest(slackInput("do: preserve the guard", "independent-review"), slackContext);
    yield* runtime.drain;
    const task = yield* onlyTask;
    const worker = task.worker!;
    beforeComplete?.(task);
    yield* report(worker.threadId, worker.runId!, "Worker's original summary.");
    harness.world.setStatus(worker.threadId, 1, "completed");
    yield* runtime.drain;
    return { runtime, task: yield* onlyTask };
  });
const finishReviewer = (
  harness: ReturnType<typeof harnessFor>,
  task: ChannelTask,
  result: unknown = pass,
) =>
  Effect.gen(function* () {
    const threadId = task.review!.threadId;
    const run = harness.world.latestRun(threadId)!;
    yield* report(threadId, run.id, JSON.stringify(result));
    harness.world.setStatus(threadId, run.ordinal, "completed");
  });
const provide = (harness: ReturnType<typeof harnessFor>) =>
  harness.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));

describe("independent channel review", () => {
  it.effect("a failed launch completes with its reason and cannot report a pass", () => {
    const harness = harnessFor();
    return Effect.gen(function* () {
      const { task } = yield* start(harness, (running) => {
        harness.world.launchFailures.add(
          reviewLaunchIdsFor(running.taskId, running.generation, running.worker!.runId!).threadId,
        );
      });
      assert.strictEqual(task.status, "completed");
      assert.strictEqual(task.review?.verdict, "failed");
      assert.include(task.resultSummary!, "could not start");
      assert.notInclude(task.resultSummary!, "review passed");
      assert.lengthOf(resultsTo(harness.slackSent, "result"), 1);
    }).pipe(Effect.provide(provide(harness)));
  });

  it.effect("restart resumes a reserved launch whose thread has no initial run yet", () => {
    const harness = harnessFor();
    return Effect.gen(function* () {
      const { runtime, task } = yield* start(harness);
      const firstLaunch = harness.world.launches[1]!;
      harness.world.runs.set(task.review!.threadId, []);
      const restarted = yield* ChannelTaskReviews.ChannelTaskReviews.pipe(
        Effect.provide(ChannelTaskReviews.layer.pipe(Layer.provide(layerNoSshHosts))),
      );
      yield* restarted.reconcile(runtime.ownerToken);
      assert.strictEqual((yield* onlyTask).status, "reviewing");
      assert.lengthOf(harness.world.runs.get(task.review!.threadId)!, 1);
      assert.deepStrictEqual(harness.world.launches[2], firstLaunch);
      yield* restarted.reconcile(runtime.ownerToken);
      assert.lengthOf(harness.world.launches, 3);
    }).pipe(Effect.provide(provide(harness)));
  });

  it.effect("a new worker run supersedes the old review without consuming a blocker round", () => {
    const harness = harnessFor();
    return Effect.gen(function* () {
      const { runtime, task } = yield* start(harness);
      const newRun = harness.world.addRun(task.worker!.threadId, MessageId.make("new-work"));
      yield* finishReviewer(harness, task);
      yield* runtime.drain;
      assert.strictEqual((yield* onlyTask).status, "running");
      assert.lengthOf(resultsTo(harness.slackSent, "result"), 0);
      yield* report(task.worker!.threadId, newRun.id, "Fresh result");
      harness.world.setStatus(task.worker!.threadId, newRun.ordinal, "completed");
      yield* runtime.drain;
      const fresh = yield* onlyTask;
      assert.strictEqual(fresh.review?.workerRunId, newRun.id);
      assert.strictEqual(fresh.review?.round, 1);
      assert.notStrictEqual(fresh.review?.threadId, task.review?.threadId);
    }).pipe(Effect.provide(provide(harness)));
  });
  it.effect("critical guard rejects completion while the durable review is open", () => {
    const harness = harnessFor();
    return Effect.gen(function* () {
      const { runtime, task } = yield* start(harness);
      const ledger = yield* ChannelLedger.ChannelLedger;
      const stored = (yield* ledger.getTask(task.taskId))!;
      const completed = yield* commitTransition(
        ledger,
        stored,
        {
          type: "task.completed",
          payload: {
            generation: task.generation,
            runId: task.worker!.runId!,
            summary: "Premature success",
            report: "present",
          },
        },
        { owner: runtime.ownerToken, narrate: true },
      );
      assert.isUndefined(completed);
      assert.strictEqual((yield* onlyTask).status, "reviewing");
      assert.lengthOf(
        (yield* events).filter((event) => event.type === "task.completed"),
        0,
      );
      assert.lengthOf(resultsTo(harness.slackSent, "result"), 0);
    }).pipe(Effect.provide(provide(harness)));
  });
  it.effect("off leaves completion and its original summary unchanged", () => {
    const harness = harnessFor(false);
    return Effect.gen(function* () {
      const { task } = yield* start(harness);
      assert.strictEqual(task.status, "completed");
      assert.strictEqual(task.resultSummary, "Worker's original summary.");
      assert.isUndefined(task.review);
      assert.lengthOf(harness.world.launches, 1);
      assert.lengthOf(resultsTo(harness.slackSent, "result"), 1);
    }).pipe(Effect.provide(provide(harness)));
  });

  it.effect(
    "holds completion, launches a separate restricted reviewer and completes once on pass",
    () => {
      const harness = harnessFor();
      return Effect.gen(function* () {
        const { runtime, task } = yield* start(harness);
        assert.strictEqual(task.status, "reviewing");
        assert.lengthOf(resultsTo(harness.slackSent, "result"), 0);
        assert.lengthOf(harness.world.launches, 2);
        const launch = harness.world.launches[1]!;
        assert.notStrictEqual(launch.threadId, task.worker!.threadId);
        assert.strictEqual(launch.runtimeMode, "approval-required");
        assert.strictEqual(launch.createdBy, "system");
        assert.deepStrictEqual(launch.modelSelection, reviewer);
        assert.include(launch.initialMessage!.text, task.instruction);
        assert.include(launch.initialMessage!.text, "+guard\n");
        const released = yield* Deferred.make<void>();
        const completion = yield* Deferred.await(released).pipe(
          Effect.andThen(finishReviewer(harness, task)),
          Effect.forkChild,
        );
        yield* runtime.drain;
        assert.strictEqual((yield* onlyTask).status, "reviewing");
        yield* Deferred.succeed(released, undefined);
        yield* Fiber.join(completion);
        harness.world.background.add(task.review!.threadId);
        yield* runtime.drain;
        assert.strictEqual((yield* onlyTask).status, "reviewing");
        harness.world.background.delete(task.review!.threadId);
        yield* runtime.drain;
        yield* runtime.drain;
        const done = yield* onlyTask;
        assert.strictEqual(done.status, "completed");
        assert.strictEqual(done.review?.verdict, "pass");
        assert.include(done.resultSummary!, "Worker's original summary.");
        assert.include(done.resultSummary!, reviewer.model);
        assert.lengthOf(resultsTo(harness.slackSent, "result"), 1);
        assert.lengthOf(
          (yield* events).filter((event) => event.type === "task.review.started"),
          1,
        );
        assert.lengthOf(
          (yield* events).filter((event) => event.type === "task.review.finished"),
          1,
        );
        assert.lengthOf(
          (yield* events).filter((event) => event.type === "task.completed"),
          1,
        );
      }).pipe(Effect.provide(provide(harness)));
    },
  );

  it.effect(
    "first blockers forward once and re-review the new run; second blockers ask the requester",
    () => {
      const harness = harnessFor();
      return Effect.gen(function* () {
        const { runtime, task } = yield* start(harness);
        yield* finishReviewer(harness, task, blockers);
        yield* runtime.drain;
        yield* runtime.drain;
        assert.lengthOf(harness.world.sends, 1);
        const correcting = yield* onlyTask;
        assert.strictEqual(correcting.status, "running");
        assert.notStrictEqual(correcting.worker!.runId, task.worker!.runId);
        assert.strictEqual(correcting.review?.findings[0]?.findingId, "guard");
        const run = harness.world.latestRun(task.worker!.threadId)!;
        yield* report(task.worker!.threadId, run.id, "Corrected worker summary.");
        harness.world.setStatus(task.worker!.threadId, run.ordinal, "completed");
        yield* runtime.drain;
        const second = yield* onlyTask;
        assert.strictEqual(second.status, "reviewing");
        assert.strictEqual(second.review?.round, 2);
        assert.notStrictEqual(second.review?.threadId, task.review?.threadId);
        yield* finishReviewer(harness, second, blockers);
        yield* runtime.drain;
        const waiting = yield* onlyTask;
        assert.strictEqual(waiting.status, "waiting_input");
        assert.lengthOf(waiting.openQuestions, 1);
        assert.lengthOf(harness.world.sends, 1);
        assert.lengthOf(resultsTo(harness.slackSent, "result"), 0);
      }).pipe(Effect.provide(provide(harness)));
    },
  );

  it.effect(
    "restart reconstructs an open review without a second launch or early completion",
    () => {
      const harness = harnessFor();
      return Effect.gen(function* () {
        const { runtime, task } = yield* start(harness);
        const restarted = yield* ChannelTaskReviews.ChannelTaskReviews.pipe(
          Effect.provide(ChannelTaskReviews.layer.pipe(Layer.provide(layerNoSshHosts))),
        );
        yield* restarted.reconcile(runtime.ownerToken);
        assert.strictEqual((yield* onlyTask).status, "reviewing");
        assert.lengthOf(harness.world.launches, 2);
        yield* finishReviewer(harness, task);
        yield* restarted.reconcile(runtime.ownerToken);
        yield* restarted.reconcile(runtime.ownerToken);
        yield* runtime.drain;
        assert.strictEqual((yield* onlyTask).status, "completed");
        assert.lengthOf(harness.world.launches, 2);
        assert.lengthOf(resultsTo(harness.slackSent, "result"), 1);
      }).pipe(Effect.provide(provide(harness)));
    },
  );

  it.effect("timeout is an honest failed review, never a passing verdict", () => {
    const harness = harnessFor();
    return Effect.gen(function* () {
      const { runtime } = yield* start(harness);
      yield* TestClock.adjust(ChannelTaskReviews.REVIEW_TIMEOUT_MS);
      yield* runtime.drain;
      const done = yield* onlyTask;
      assert.strictEqual(done.status, "completed");
      assert.strictEqual(done.review?.verdict, "failed");
      assert.include(done.resultSummary!, "timed out");
      assert.notInclude(done.resultSummary!, "review passed");
      assert.lengthOf(resultsTo(harness.slackSent, "result"), 1);
    }).pipe(Effect.provide(provide(harness)));
  });

  it.effect("cancel and retry fence late reviewer results from the old generation", () => {
    const harness = harnessFor();
    return Effect.gen(function* () {
      const { runtime, task } = yield* start(harness);
      const ledger = yield* ChannelLedger.ChannelLedger;
      const stored = (yield* ledger.getTask(task.taskId))!;
      yield* commitTransition(
        ledger,
        stored,
        { type: "task.cancelled", payload: { reason: "Stopped" } },
        { owner: runtime.ownerToken },
      );
      yield* finishReviewer(harness, task);
      yield* runtime.drain;
      assert.strictEqual((yield* onlyTask).status, "cancelled");
      yield* commitTransition(
        ledger,
        (yield* ledger.getTask(task.taskId))!,
        { type: "task.retry.requested", payload: { generation: 2 } },
        { owner: runtime.ownerToken },
      );
      yield* runtime.drain;
      const fresh = yield* onlyTask;
      assert.strictEqual(fresh.generation, 2);
      assert.strictEqual(fresh.status, "running");
      assert.isUndefined(fresh.review);
      assert.lengthOf(resultsTo(harness.slackSent, "result"), 0);
    }).pipe(Effect.provide(provide(harness)));
  });
});
