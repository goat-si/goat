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
import * as ServerSettings from "../serverSettings.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ReviewService from "../review/ReviewService.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelDispatcher from "./ChannelDispatcher.ts";
import * as ChannelLayers from "./ChannelLayers.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import * as ChannelTaskReviews from "./ChannelTaskReviews.ts";
import * as ChannelReviewCleanup from "./ChannelReviewCleanup.ts";
import * as SlackChannelSettings from "./SlackChannelSettings.ts";
import { commitTransition } from "./channelTaskWrites.ts";
import { reviewLaunchIdsFor, turnSteerIdsFor } from "./channelIds.ts";
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

function harnessFor(enabled = true, unsupportedMode = false) {
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
        ...(unsupportedMode ? { supportedRuntimeModes: ["full-access" as const] } : {}),
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
  it.effect("identity-timeout question recovers after its separate ledger write failed", () => {
    const harness = harnessFor();
    return Effect.gen(function* () {
      const { runtime, task } = yield* start(harness);
      const ledger = yield* ChannelLedger.ChannelLedger;
      const original = ledger.applyTaskEvent;
      let failed = false;
      const mutable: { applyTaskEvent: typeof original } = ledger;
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          mutable.applyTaskEvent = (input) => {
            if (!failed && input.write.event.type === "task.question.opened") {
              failed = true;
              return Effect.fail(
                new ChannelLedger.ChannelLedgerError({
                  reason: "persistence",
                  detail: "Synthetic failed question commit",
                }),
              );
            }
            return original(input);
          };
        }),
        () =>
          Effect.sync(() => {
            mutable.applyTaskEvent = original;
          }),
      );
      harness.world.recordFailures.add(task.worker!.threadId);
      yield* TestClock.adjust(ChannelTaskReviews.REVIEW_TIMEOUT_MS);
      const before = yield* (yield* ChannelTaskReviews.ChannelTaskReviews)
        .reconcile(runtime.ownerToken)
        .pipe(Effect.result);
      assert.strictEqual(before._tag, "Failure");
      assert.strictEqual((yield* onlyTask).status, "reviewing");
      assert.strictEqual((yield* onlyTask).review?.identityTimeout, true);
      const restarted = yield* ChannelTaskReviews.ChannelTaskReviews.pipe(
        Effect.provide(ChannelTaskReviews.layer.pipe(Layer.provide(layerNoSshHosts))),
      );
      yield* restarted.reconcile(runtime.ownerToken);
      yield* runtime.drain;
      assert.strictEqual((yield* onlyTask).status, "waiting_input");
      assert.lengthOf((yield* onlyTask).openQuestions, 1);
      assert.lengthOf(resultsTo(harness.slackSent, "result"), 0);
    }).pipe(Effect.provide(provide(harness)));
  });

  it.effect.each([false, true])(
    "decided local review survives an identity outage beyond timeout: blockers=%s",
    (blocked) => {
      const harness = harnessFor();
      return Effect.gen(function* () {
        const { runtime, task } = yield* start(harness);
        yield* finishReviewer(harness, task, blocked ? blockers : pass);
        const reviews = yield* ChannelTaskReviews.ChannelTaskReviews;
        yield* reviews.reconcile(runtime.ownerToken);
        harness.world.recordFailures.add(task.worker!.threadId);
        yield* TestClock.adjust(ChannelTaskReviews.REVIEW_TIMEOUT_MS);
        yield* runtime.drain;
        assert.strictEqual((yield* onlyTask).status, "reviewing");
        assert.lengthOf((yield* onlyTask).openQuestions, 0);
        assert.lengthOf(harness.world.sends, 0);
        harness.world.recordFailures.delete(task.worker!.threadId);
        yield* runtime.drain;
        assert.strictEqual((yield* onlyTask).status, blocked ? "running" : "completed");
        assert.lengthOf(harness.world.sends, blocked ? 1 : 0);
        assert.lengthOf(resultsTo(harness.slackSent, "result"), blocked ? 0 : 1);
      }).pipe(Effect.provide(provide(harness)));
    },
  );
  it.effect(
    "a failure to record prelaunch refusal cannot resurrect retired cleanup ownership",
    () => {
      const harness = harnessFor();
      return Effect.gen(function* () {
        const ledger = yield* ChannelLedger.ChannelLedger;
        const original = ledger.applyTaskEvent;
        let failed = false;
        const mutable: { applyTaskEvent: typeof original } = ledger;
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            mutable.applyTaskEvent = (input) => {
              if (!failed && input.write.event.type === "task.review.finished") {
                failed = true;
                return Effect.fail(
                  new ChannelLedger.ChannelLedgerError({
                    reason: "persistence",
                    detail: "Synthetic failed outcome commit",
                  }),
                );
              }
              return original(input);
            };
          }),
          () =>
            Effect.sync(() => {
              mutable.applyTaskEvent = original;
            }),
        );
        const result = yield* start(harness, (running) => {
          harness.world.prelaunchFailures.add(
            reviewLaunchIdsFor(running.taskId, running.generation, running.worker!.runId!).threadId,
          );
        }).pipe(Effect.result);
        assert.strictEqual(result._tag, "Failure");
        const task = yield* onlyTask;
        harness.world.prelaunchFailures.delete(task.review!.threadId);
        yield* (yield* ChannelRuntime.ChannelRuntime).drain;
        assert.strictEqual((yield* onlyTask).status, "completed");
        assert.strictEqual((yield* onlyTask).review?.verdict, "failed");
        assert.lengthOf(harness.world.launches, 2);
        assert.isUndefined(harness.world.latestRun(task.review!.threadId));
      }).pipe(Effect.provide(provide(harness)));
    },
  );

  it.effect(
    "unknown local worker identity times out to a question without applying a verdict",
    () => {
      const harness = harnessFor();
      return Effect.gen(function* () {
        const { runtime, task } = yield* start(harness);
        harness.world.recordFailures.add(task.worker!.threadId);
        yield* TestClock.adjust(ChannelTaskReviews.REVIEW_TIMEOUT_MS);
        yield* runtime.drain;
        const waiting = yield* onlyTask;
        assert.strictEqual(waiting.status, "waiting_input");
        assert.strictEqual(waiting.review?.verdict, "failed");
        assert.lengthOf(waiting.openQuestions, 1);
        assert.include(waiting.openQuestions[0]!.text, "timed out");
        assert.lengthOf(resultsTo(harness.slackSent, "result"), 0);
        assert.include(harness.world.interrupts, task.review!.threadId);
        yield* runtime.drain;
        assert.lengthOf((yield* onlyTask).openQuestions, 1);
      }).pipe(Effect.provide(provide(harness)));
    },
  );
  it.effect("definite local prelaunch failure retires cleanup without interrupt attempts", () => {
    const harness = harnessFor();
    return Effect.gen(function* () {
      const { runtime, task } = yield* start(harness, (running) => {
        harness.world.prelaunchFailures.add(
          reviewLaunchIdsFor(running.taskId, running.generation, running.worker!.runId!).threadId,
        );
      });
      assert.strictEqual(task.review?.verdict, "failed");
      const ledger = yield* ChannelLedger.ChannelLedger;
      assert.lengthOf(yield* ledger.listReviewCleanup("2099-01-01T00:00:00.000Z"), 0);
      yield* runtime.drain;
      assert.lengthOf(harness.world.interrupts, 0);
    }).pipe(Effect.provide(provide(harness)));
  });

  it.effect.each([null, { verdict: "pass", summary: "Malformed", findings: [{}] }])(
    "malformed reviewer output fails honestly: %j",
    (result) => {
      const harness = harnessFor();
      return Effect.gen(function* () {
        const { runtime, task } = yield* start(harness);
        yield* finishReviewer(harness, task, result);
        yield* runtime.drain;
        assert.strictEqual((yield* onlyTask).review?.verdict, "failed");
        assert.notInclude((yield* onlyTask).resultSummary!, "review passed");
      }).pipe(Effect.provide(provide(harness)));
    },
  );

  it.effect("a persisted local correction cannot follow a different worker run", () => {
    const harness = harnessFor();
    return Effect.gen(function* () {
      const { runtime, task } = yield* start(harness);
      yield* finishReviewer(harness, task, blockers);
      const reviews = yield* ChannelTaskReviews.ChannelTaskReviews;
      yield* reviews.reconcile(runtime.ownerToken);
      yield* reviews.reconcile(runtime.ownerToken);
      const ledger = yield* ChannelLedger.ChannelLedger;
      const pending = (yield* ledger.listPendingForwards(50))[0]!;
      assert.strictEqual(pending.event.type, "task.followup.received");
      if (pending.event.type !== "task.followup.received") throw new Error("expected correction");
      assert.strictEqual(pending.event.payload.expectedWorkerRunId, task.worker!.runId);
      const newer = harness.world.addRun(
        task.worker!.threadId,
        MessageId.make("newer-before-correction"),
      );
      yield* (yield* ChannelDispatcher.ChannelDispatcher).forward(pending, runtime.ownerToken);
      assert.lengthOf(harness.world.sends, 0);
      assert.strictEqual((yield* onlyTask).worker!.runId, newer.id);
      assert.isUndefined((yield* ledger.getTask(task.taskId))!.pendingAnswerMessageId);
    }).pipe(Effect.provide(provide(harness)));
  });

  it.effect(
    "durably retries superseded reviewer cleanup after restart without holding new work",
    () => {
      const harness = harnessFor();
      return Effect.gen(function* () {
        const { runtime, task } = yield* start(harness);
        const reviewerThread = task.review!.threadId;
        harness.world.interruptFailures.add(reviewerThread);
        harness.world.addRun(task.worker!.threadId, MessageId.make("superseding-work"));
        yield* runtime.drain;
        assert.strictEqual((yield* onlyTask).status, "running");
        assert.deepStrictEqual(harness.world.interrupts, [reviewerThread]);
        yield* runtime.drain;
        assert.lengthOf(harness.world.interrupts, 1);
        const restarted = yield* ChannelReviewCleanup.ChannelReviewCleanup.pipe(
          Effect.provide(ChannelReviewCleanup.layer.pipe(Layer.provide(layerNoSshHosts))),
        );
        harness.world.interruptFailures.delete(reviewerThread);
        yield* TestClock.adjust(ChannelReviewCleanup.REVIEW_CLEANUP_RETRY_MS);
        yield* restarted.reconcile(runtime.ownerToken);
        assert.deepStrictEqual(harness.world.interrupts, [reviewerThread, reviewerThread]);
        assert.strictEqual(harness.world.latestRun(reviewerThread)?.status, "cancelled");
        yield* TestClock.adjust(ChannelReviewCleanup.REVIEW_CLEANUP_RETRY_MS * 2);
        yield* restarted.reconcile(runtime.ownerToken);
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{
          done: number;
        }>`SELECT json_extract(value_json, '$.done') AS done FROM channel_runtime_state WHERE key = ${"review:cleanup:" + reviewerThread}`;
        assert.deepStrictEqual(rows, [{ done: 1 }]);
        assert.lengthOf(harness.world.launches, 2);
        assert.lengthOf(resultsTo(harness.slackSent, "result"), 0);
      }).pipe(Effect.provide(provide(harness)));
    },
  );

  it.effect.each(["high", "critical", "info"])(
    "rejects contradictory pass with %s findings",
    (severity) => {
      const harness = harnessFor();
      return Effect.gen(function* () {
        const { runtime, task } = yield* start(harness);
        yield* finishReviewer(harness, task, {
          ...pass,
          findings: [{ ...blockers.findings[0]!, severity }],
        });
        yield* runtime.drain;
        const done = yield* onlyTask;
        assert.strictEqual(done.review?.verdict, "failed");
        assert.notInclude(done.resultSummary!, "review passed");
        assert.lengthOf(resultsTo(harness.slackSent, "result"), 1);
      }).pipe(Effect.provide(provide(harness)));
    },
  );

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

it.effect("refuses an unsupported restricted reviewer mode without launching", () => {
  const harness = harnessFor(true, true);
  return Effect.gen(function* () {
    const { task } = yield* start(harness);
    assert.strictEqual(task.status, "completed");
    assert.strictEqual(task.review?.verdict, "skipped");
    assert.include(task.review?.summary ?? "", "approval-required");
    assert.lengthOf(harness.world.launches, 1);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("honors the current goatclaw profile before a local review launch", () => {
  const harness = harnessFor();
  return Effect.gen(function* () {
    yield* setupBot;
    yield* linkSlackUser();
    const runtime = yield* ChannelRuntime.ChannelRuntime;
    yield* (yield* ChannelGateway.ChannelGateway).ingest(
      slackInput("do: preserve the guard", "review-profile-denied"),
      slackContext,
    );
    yield* runtime.drain;
    const task = yield* onlyTask;
    const settings = yield* ServerSettings.ServerSettingsService;
    yield* settings.updateSettings({ goatclaw: { enabled: true, defaultProfile: "observer" } });
    yield* report(task.worker!.threadId, task.worker!.runId!, "Worker's original summary.");
    harness.world.setStatus(task.worker!.threadId, 1, "completed");
    yield* runtime.drain;
    const reviewed = yield* onlyTask;
    assert.strictEqual(reviewed.status, "completed");
    assert.strictEqual(reviewed.review?.verdict, "skipped");
    assert.include(reviewed.review?.summary ?? "", "permission profile");
    assert.lengthOf(harness.world.launches, 1);
  }).pipe(Effect.provide(harness.layer));
});

it.effect(
  "binds the restricted reviewer ceiling and releases its goatclaw lane after cleanup",
  () => {
    const harness = harnessFor();
    return Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings({ goatclaw: { enabled: true, defaultProfile: "worker" } });
      const { runtime, task } = yield* start(harness);
      assert.strictEqual(task.status, "reviewing");
      const sql = yield* SqlClient.SqlClient;
      const profiles = yield* sql<{
        ceiling_json: string;
      }>`SELECT ceiling_json FROM goatclaw_thread_profiles WHERE thread_id = ${task.review!.threadId}`;
      assert.strictEqual(
        JSON.parse(profiles[0]!.ceiling_json).runtimeModeCeiling,
        "approval-required",
      );
      const count = () =>
        sql<{ count: number }>`SELECT COUNT(*) AS count FROM goatclaw_lane_reservations`;
      assert.deepStrictEqual(yield* count(), [{ count: 1 }]);
      yield* finishReviewer(harness, task, pass);
      yield* runtime.drain;
      yield* TestClock.adjust(ChannelReviewCleanup.REVIEW_CLEANUP_RETRY_MS);
      yield* runtime.drain;
      assert.strictEqual((yield* onlyTask).review?.verdict, "pass");
      assert.deepStrictEqual(yield* count(), [{ count: 0 }]);
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect.each(["identity-revoked", "observer", "lane-limit"] as const)(
  "refuses a review correction after current authority changes: %s",
  (scenario) => {
    const harness = harnessFor();
    return Effect.gen(function* () {
      const { runtime, task } = yield* start(harness);
      const workerRun = harness.world.latestRun(task.worker!.threadId)!.id;
      if (scenario === "lane-limit") {
        harness.world.shells.set(task.worker!.threadId, { runtimeMode: "approval-required" });
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO orchestration_v2_projection_threads
          (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
          VALUES (${task.worker!.threadId}, ${task.target!.projectId}, 'Worker', 'codex', 'approval-required', 'default', ${now}, ${now}, '{}')`;
      }
      if (scenario === "identity-revoked") {
        yield* (yield* ChannelLedger.ChannelLedger).unlinkIdentity({
          connectionId: "slack-1",
          externalActorId: "U1",
        });
      } else {
        const settings = yield* ServerSettings.ServerSettingsService;
        const policy = (yield* settings.getSettings).goatclaw;
        yield* settings.updateSettings({
          goatclaw: {
            ...policy,
            enabled: true,
            defaultProfile: scenario === "observer" ? "observer" : "worker",
            ...(scenario === "lane-limit"
              ? {
                  profiles: {
                    ...policy.profiles,
                    worker: { ...policy.profiles.worker!, maxLanes: 0 },
                  },
                }
              : {}),
          },
        });
      }
      yield* finishReviewer(harness, task, blockers);
      yield* runtime.drain;
      const waiting = yield* onlyTask;
      assert.strictEqual(waiting.status, "waiting_input");
      assert.include(waiting.openQuestions[0]?.text ?? "", "permission");
      assert.strictEqual(harness.world.latestRun(task.worker!.threadId)!.id, workerRun);
      assert.isUndefined(
        (yield* (yield* ChannelLedger.ChannelLedger).getTask(task.taskId))!.pendingAnswerMessageId,
      );
      yield* runtime.drain;
      assert.strictEqual(harness.world.latestRun(task.worker!.threadId)!.id, workerRun);
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect(
  "admits one authorized review correction and replays its receipt without another run",
  () => {
    const harness = harnessFor();
    return Effect.gen(function* () {
      const { runtime, task } = yield* start(harness);
      harness.world.shells.set(task.worker!.threadId, { runtimeMode: "approval-required" });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO orchestration_v2_projection_threads
      (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
      VALUES (${task.worker!.threadId}, ${task.target!.projectId}, 'Worker', 'codex', 'approval-required', 'default', ${now}, ${now}, '{}')`;
      yield* (yield* ServerSettings.ServerSettingsService).updateSettings({
        goatclaw: { enabled: true, defaultProfile: "worker" },
      });
      yield* finishReviewer(harness, task, blockers);
      yield* runtime.drain;
      const corrected = harness.world.latestRun(task.worker!.threadId)!;
      assert.notStrictEqual(corrected.id, task.worker!.runId);
      assert.strictEqual(harness.world.sends.at(-1)?.expectedLatestRunId, task.worker!.runId);
      const [replay] = yield* sql<{
        sequence: number;
        event_json: string;
      }>`SELECT sequence, event_json FROM channel_task_events WHERE json_extract(event_json, '$.type') = 'task.followup.received' ORDER BY sequence DESC LIMIT 1`;
      assert.isDefined(replay);
      const sendsBeforeReplay = harness.world.sends.length;
      yield* (yield* ChannelDispatcher.ChannelDispatcher).forward(
        {
          sequence: replay!.sequence,
          event: eventDecoder(replay!.event_json),
        },
        runtime.ownerToken,
      );
      assert.strictEqual(harness.world.sends.length, sendsBeforeReplay + 1);
      assert.strictEqual(harness.world.latestRun(task.worker!.threadId)!.id, corrected.id);
      assert.strictEqual(harness.world.sends.at(-1)?.expectedLatestRunId, task.worker!.runId);
      const reservations = yield* sql<{
        pending: number;
      }>`SELECT pending FROM goatclaw_lane_reservations WHERE child_thread_id = ${task.worker!.threadId}`;
      assert.deepStrictEqual(reservations, [{ pending: 0 }]);
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect.each(["precommit-new-run", "accepted-revoked", "precommit-cancelled"] as const)(
  "retains abandoned local correction ownership through restart until terminal proof: %s",
  (scenario) => {
    const harness = harnessFor();
    return Effect.gen(function* () {
      const { runtime, task } = yield* start(harness);
      const workerId = task.worker!.threadId;
      harness.world.shells.set(workerId, { runtimeMode: "approval-required" });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO orchestration_v2_projection_threads
        (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
        VALUES (${workerId}, ${task.target!.projectId}, 'Worker', 'codex', 'approval-required', 'default', ${now}, ${now}, '{}')`;
      yield* (yield* ServerSettings.ServerSettingsService).updateSettings({
        goatclaw: { enabled: true, defaultProfile: "worker" },
      });
      yield* finishReviewer(harness, task, blockers);
      const reviews = yield* ChannelTaskReviews.ChannelTaskReviews;
      yield* reviews.reconcile(runtime.ownerToken);
      yield* reviews.reconcile(runtime.ownerToken);
      const ledger = yield* ChannelLedger.ChannelLedger;
      const pending = (yield* ledger.listPendingForwards(50))[0]!;
      if (pending.event.type !== "task.followup.received") throw new Error("expected correction");
      const ids = turnSteerIdsFor(pending.event.payload.inputId);
      const slots = () =>
        sql<{
          id: string;
          pending: number;
        }>`SELECT id, pending FROM goatclaw_lane_reservations WHERE id = ${ids.commandId}`;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const original = threads.sendToThread;
      const mutable: { sendToThread: typeof original } = threads;
      let loseReply = true;
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          mutable.sendToThread = (input) => {
            if (!loseReply || input.commandId !== ids.commandId) return original(input);
            loseReply = false;
            const failure = Effect.fail(
              new Orchestrator.OrchestratorDispatchError({
                commandId: input.commandId,
                commandType: "message.dispatch",
              }),
            );
            return scenario === "accepted-revoked"
              ? original(input).pipe(Effect.andThen(failure))
              : failure;
          };
        }),
        () =>
          Effect.sync(() => {
            mutable.sendToThread = original;
          }),
      );
      const dispatcher = yield* ChannelDispatcher.ChannelDispatcher;
      yield* dispatcher.forward(pending, runtime.ownerToken);
      assert.deepStrictEqual(yield* slots(), [{ id: ids.commandId, pending: 1 }]);
      yield* (yield* ChannelReviewCleanup.ChannelReviewCleanup).reconcile(runtime.ownerToken);
      assert.deepStrictEqual(yield* slots(), [{ id: ids.commandId, pending: 1 }]);
      assert.notInclude(harness.world.interrupts, workerId);
      yield* sql`INSERT INTO goatclaw_lane_reservations (id, owner_key, child_thread_id, pending)
        VALUES ('unrelated-admission', 'unrelated-owner', ${workerId}, 1)`;
      if (scenario === "accepted-revoked") {
        yield* ledger.unlinkIdentity({ connectionId: "slack-1", externalActorId: "U1" });
      } else {
        harness.world.addRun(workerId, MessageId.make("unrelated-after-ambiguous-correction"));
        if (scenario === "precommit-cancelled") {
          yield* commitTransition(
            ledger,
            (yield* ledger.getTask(task.taskId))!,
            { type: "task.cancelled", payload: { reason: "Stopped" } },
            { owner: runtime.ownerToken },
          );
        }
      }
      const active = harness.world.latestRun(workerId)!;
      const beforeRetry = harness.world.runs.get(workerId)!.slice();
      yield* dispatcher.forward(pending, runtime.ownerToken);
      assert.deepStrictEqual(harness.world.runs.get(workerId), beforeRetry);
      assert.deepStrictEqual(yield* slots(), [{ id: ids.commandId, pending: 1 }]);
      assert.isEmpty(yield* ledger.listPendingForwards(50));
      if (scenario === "accepted-revoked") {
        assert.strictEqual((yield* onlyTask).status, "waiting_input");
        assert.include((yield* onlyTask).openQuestions[0]!.text, "permission");
      }
      const restarted = yield* ChannelReviewCleanup.ChannelReviewCleanup.pipe(
        Effect.provide(ChannelReviewCleanup.layer.pipe(Layer.provide(layerNoSshHosts))),
      );
      harness.world.recordFailures.add(workerId);
      yield* TestClock.adjust(ChannelReviewCleanup.REVIEW_CLEANUP_RETRY_MS);
      yield* restarted.reconcile(runtime.ownerToken);
      assert.deepStrictEqual(yield* slots(), [{ id: ids.commandId, pending: 1 }]);
      harness.world.recordFailures.delete(workerId);
      yield* TestClock.adjust(ChannelReviewCleanup.REVIEW_CLEANUP_RETRY_MS * 2);
      yield* restarted.reconcile(runtime.ownerToken);
      assert.deepStrictEqual(yield* slots(), [{ id: ids.commandId, pending: 1 }]);
      assert.notInclude(harness.world.interrupts, workerId);
      harness.world.setStatus(workerId, active.ordinal, "completed");
      harness.world.background.add(workerId);
      yield* TestClock.adjust(ChannelReviewCleanup.REVIEW_CLEANUP_RETRY_MS * 4);
      yield* restarted.reconcile(runtime.ownerToken);
      assert.deepStrictEqual(yield* slots(), [{ id: ids.commandId, pending: 1 }]);
      harness.world.background.delete(workerId);
      yield* TestClock.adjust(ChannelReviewCleanup.REVIEW_CLEANUP_RETRY_MS * 8);
      yield* restarted.reconcile(runtime.ownerToken);
      assert.deepStrictEqual(yield* slots(), []);
      assert.notInclude(harness.world.interrupts, workerId);
      yield* dispatcher.forward(pending, runtime.ownerToken);
      assert.deepStrictEqual(yield* slots(), []);
      assert.lengthOf(harness.world.runs.get(workerId)!, 2);
      assert.deepStrictEqual(
        yield* sql<{
          id: string;
          pending: number;
        }>`SELECT id, pending FROM goatclaw_lane_reservations WHERE id = 'unrelated-admission'`,
        [{ id: "unrelated-admission", pending: 1 }],
      );
    }).pipe(Effect.provide(harness.layer));
  },
);
