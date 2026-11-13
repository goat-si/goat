import { assert, it } from "@effect/vitest";
import {
  ChannelInputId,
  CommandId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  RunId,
} from "@goat/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import { ACCEPTED_RUN_WAIT_MS, makeForwardFollowUp } from "./channelForwardFollowUp.ts";
import { turnSteerIdsFor } from "./channelIds.ts";
import { commitTransition } from "./channelTaskWrites.ts";
import {
  linkSlackUser,
  makeHarness,
  onlyTask,
  setupBot,
  slackContext,
  slackInput,
} from "./testkit/ChannelHarness.ts";

const UNCONFIRMED =
  "The requester’s permission changed, and GOAT could not confirm your follow-up started in the thread. Open the thread in GOAT to check it.";
const inputId = ChannelInputId.make("input:accepted-follow-up");
const fence = turnSteerIdsFor(inputId, "first").messageId;
const ghostRun = RunId.make("run:accepted-follow-up");

/**
 * A worker task with a follow-up the thread accepted, recorded before the requester's access was
 * revoked. The thread shows the follow-up's message; whether its run shows depends on `runShows`.
 */
const acceptedFollowUp = (
  harness: ReturnType<typeof makeHarness>,
  runShows: () => boolean,
  readFails: () => boolean = () => false,
) =>
  Effect.gen(function* () {
    yield* setupBot;
    yield* linkSlackUser();
    const gateway = yield* ChannelGateway.ChannelGateway;
    const runtime = yield* ChannelRuntime.ChannelRuntime;
    const ledger = yield* ChannelLedger.ChannelLedger;
    yield* gateway.ingest(slackInput("do: inspect the build", "accepted-1"), slackContext);
    yield* runtime.drain;
    const task = yield* onlyTask;
    yield* commitTransition(
      ledger,
      (yield* ledger.getTask(task.taskId))!,
      {
        type: "task.followup.received",
        payload: { inputId, text: "and the docs", from: "Owner", generation: task.generation },
      },
      { owner: runtime.ownerToken, forward: true, pendingAnswerMessageId: fence },
    );
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE channel_identities SET granted_scopes_json = '[]' WHERE connection_id = 'slack-1' AND external_actor_id = 'U1'`;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const worker = task.worker!.threadId;
    // Decided when the read runs, as a real read is.
    const getThreadRecords = ((threadId, fields, options) =>
      Effect.suspend(() =>
        threadId === worker && readFails()
          ? Effect.fail(
              new Orchestrator.OrchestratorDispatchError({
                commandId: CommandId.make("records-read"),
                commandType: "thread.records.read",
              }),
            )
          : threads.getThreadRecords(threadId, fields, options),
      ).pipe(
        Effect.map((records) => {
          const read = records as unknown as {
            readonly messages?: ReadonlyArray<OrchestrationV2ConversationMessage>;
            readonly runs: ReadonlyArray<OrchestrationV2Run>;
          };
          if (threadId !== worker || read.messages === undefined) return records;
          const base = read.runs.at(-1)!;
          return {
            ...records,
            messages: [
              ...read.messages,
              {
                id: fence,
                role: "user",
                text: "",
                streaming: false,
                runId: ghostRun,
                createdAt: base.requestedAt,
              },
            ],
            runs: runShows()
              ? [...read.runs, { ...base, id: ghostRun, userMessageId: fence }]
              : read.runs,
          } as typeof records;
        }),
      )) as typeof threads.getThreadRecords;
    const forwardFollowUp = yield* makeForwardFollowUp().pipe(
      Effect.provideService(ThreadManagement.ThreadManagementService, {
        ...threads,
        getThreadRecords,
      }),
    );
    const forward = Effect.gen(function* () {
      const [pending] = yield* ledger.listPendingForwards(10);
      if (pending === undefined || pending.event.type !== "task.followup.received") return;
      yield* forwardFollowUp(pending, pending.event, runtime.ownerToken);
    });
    return { task, ledger, forward };
  });

it.effect(
  "regression: a follow-up whose run never starts stops waiting at the bound and tells the requester",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const { task, ledger, forward } = yield* acceptedFollowUp(harness, () => false);
      yield* forward;
      yield* TestClock.adjust(Duration.millis(ACCEPTED_RUN_WAIT_MS - 1));
      yield* forward;
      assert.lengthOf(yield* ledger.listPendingForwards(10), 1);
      assert.deepStrictEqual((yield* onlyTask).openQuestions, []);
      yield* TestClock.adjust(Duration.millis(1));
      yield* forward;
      assert.lengthOf(yield* ledger.listPendingForwards(10), 0);
      const told = yield* onlyTask;
      assert.deepStrictEqual(
        told.openQuestions.map((question) => question.text),
        [UNCONFIRMED],
      );
      assert.isUndefined((yield* ledger.getTask(task.taskId))!.pendingAnswerMessageId);
      assert.lengthOf(harness.world.sends, 0);
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect(
  "contract: a follow-up on a thread that cannot be read is never refused blind; it stays pending past the bound",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const { task, ledger, forward } = yield* acceptedFollowUp(harness, () => false);
      harness.world.recordFailures.add(task.worker!.threadId);
      yield* forward;
      assert.lengthOf(yield* ledger.listPendingForwards(10), 1);
      yield* TestClock.adjust(Duration.millis(ACCEPTED_RUN_WAIT_MS));
      yield* forward;
      assert.lengthOf(yield* ledger.listPendingForwards(10), 1);
      assert.deepStrictEqual((yield* onlyTask).openQuestions, []);
      assert.strictEqual((yield* ledger.getTask(task.taskId))!.pendingAnswerMessageId, fence);
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect(
  "regression: a follow-up whose run appears after the deadline read is not refused, and its run is bound",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      let shows = false;
      const { task, ledger, forward } = yield* acceptedFollowUp(harness, () => shows);
      // The run appears once the deadline refusal takes its lock, after the pass read the thread.
      const lockable = ledger as { underWorkerLock: typeof ledger.underWorkerLock };
      const lock = lockable.underWorkerLock;
      lockable.underWorkerLock = (owner, body) =>
        Effect.suspend(() => {
          shows = true;
          return lock(owner, body);
        });
      yield* TestClock.adjust(Duration.millis(ACCEPTED_RUN_WAIT_MS));
      yield* forward;
      assert.lengthOf(yield* ledger.listPendingForwards(10), 1);
      assert.deepStrictEqual((yield* onlyTask).openQuestions, []);
      assert.isTrue(shows);
      yield* forward;
      assert.lengthOf(yield* ledger.listPendingForwards(10), 0);
      const bound = (yield* ledger.getTask(task.taskId))!;
      assert.strictEqual(bound.task.worker?.runId, ghostRun);
      assert.isUndefined(bound.pendingAnswerMessageId);
      assert.deepStrictEqual(bound.task.openQuestions, []);
      assert.lengthOf(harness.world.sends, 0);
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect(
  "regression: a follow-up past the deadline is not refused when the locked re-read of its thread fails, and its run is bound later",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      let shows = false;
      let fails = false;
      const { task, ledger, forward } = yield* acceptedFollowUp(
        harness,
        () => shows,
        () => fails,
      );
      // The run exists, but the re-read under the refusal's lock cannot read the thread.
      const lockable = ledger as { underWorkerLock: typeof ledger.underWorkerLock };
      const lock = lockable.underWorkerLock;
      lockable.underWorkerLock = (owner, body) =>
        Effect.suspend(() => {
          shows = true;
          fails = true;
          return lock(owner, body);
        });
      yield* TestClock.adjust(Duration.millis(ACCEPTED_RUN_WAIT_MS));
      yield* forward;
      assert.isTrue(shows);
      assert.lengthOf(yield* ledger.listPendingForwards(10), 1);
      assert.deepStrictEqual((yield* onlyTask).openQuestions, []);
      assert.strictEqual((yield* ledger.getTask(task.taskId))!.pendingAnswerMessageId, fence);
      lockable.underWorkerLock = lock;
      fails = false;
      yield* forward;
      assert.lengthOf(yield* ledger.listPendingForwards(10), 0);
      const bound = (yield* ledger.getTask(task.taskId))!;
      assert.strictEqual(bound.task.worker?.runId, ghostRun);
      assert.isUndefined(bound.pendingAnswerMessageId);
      assert.deepStrictEqual(bound.task.openQuestions, []);
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect("authority: a follow-up whose accepted run shows within the bound counts as sent", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    let shows = false;
    const { task, ledger, forward } = yield* acceptedFollowUp(harness, () => shows);
    yield* forward;
    shows = true;
    yield* TestClock.adjust(Duration.millis(ACCEPTED_RUN_WAIT_MS - 1));
    yield* forward;
    assert.lengthOf(yield* ledger.listPendingForwards(10), 0);
    const bound = (yield* ledger.getTask(task.taskId))!;
    assert.strictEqual(bound.task.worker?.runId, ghostRun);
    assert.isUndefined(bound.pendingAnswerMessageId);
    assert.deepStrictEqual(bound.task.openQuestions, []);
    assert.lengthOf(harness.world.sends, 0);
  }).pipe(Effect.provide(harness.layer));
});
