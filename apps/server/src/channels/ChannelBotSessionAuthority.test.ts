import { assert, describe, it } from "@effect/vitest";
import type { ChannelConversationId, ChannelTask } from "@goat/contracts";
import { ChannelQuestionId, CommandId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import { DispatchModeLimit } from "../orchestration-v2/DispatchModeLimit.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { nextTurnSelectionHarness } from "../orchestration-v2/testkit/SteeringHarness.ts";
import * as ChannelBotSession from "./ChannelBotSession.ts";
import * as ChannelDispatcher from "./ChannelDispatcher.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelIdentityService from "./ChannelIdentityService.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelReceptionService from "./ChannelReceptionService.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import { refuseForward } from "./channelForwardRefusal.ts";
import {
  answerForwardIdsFor,
  goatBotSessionThreadIdFor,
  sessionLaunchIdsFor,
  taskEventIdFor,
  taskIdFor,
  turnSteerIdsFor,
} from "./channelIds.ts";
import { commitTransition, prepareTransition } from "./channelTaskWrites.ts";
import * as SqlClient from "effect/sql/SqlClient";
import {
  environmentId,
  owner,
  projectId,
  setupBot,
  slackContext,
  slackInput,
} from "./testkit/ChannelHarness.ts";
import {
  ask,
  botModel,
  current,
  runsOf,
  sessionHarness,
  settle,
} from "./ChannelBotSession.testkit.ts";

/** Links Slack user U2 as a teammate, who sees the owner's other work only with orchestration:read. */
const linkTeammate = Effect.gen(function* () {
  const identities = yield* ChannelIdentityService.ChannelIdentityService;
  const gateway = yield* ChannelGateway.ChannelGateway;
  const { code } = yield* identities.createLink(
    {
      connectionId: "slack-1",
      runtimeModeCeiling: "auto-accept-edits",
      grantedScopes: ["orchestration:read", "orchestration:operate"],
    },
    { ...owner, principalId: "teammate", displayName: "Teammate" },
  );
  yield* gateway.linkIdentity(
    {
      connectionId: "slack-1",
      externalActorId: "U2",
      code,
      idempotencyKey: "link-U2",
      replyAddress: slackInput("", "unused").replyAddress,
    },
    slackContext,
  );
});

const narrowTeammate = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) =>
    sql`UPDATE channel_identities SET granted_scopes_json = '["orchestration:operate"]' WHERE connection_id = 'slack-1' AND external_actor_id = 'U2'`,
);

/** The teammate's message in one Slack thread, read but not yet dispatched. */
const receiveFromTeammate = (text: string, key: string) =>
  Effect.gen(function* () {
    const gateway = yield* ChannelGateway.ChannelGateway;
    const reception = yield* ChannelReceptionService.ChannelReceptionService;
    const runtime = yield* ChannelRuntime.ChannelRuntime;
    yield* runtime.drain;
    const ledger = yield* ChannelLedger.ChannelLedger;
    const ingested = yield* gateway.ingest(
      slackInput(text, key, "1760000000.000900", "U2"),
      slackContext,
    );
    yield* reception.receive(ingested.inputId, runtime.ownerToken);
    return (yield* ledger.getTask(taskIdFor(ingested.inputId, 0)))!.task;
  });

const dispatchNow = (task: ChannelTask) =>
  Effect.gen(function* () {
    const runtime = yield* ChannelRuntime.ChannelRuntime;
    const dispatcher = yield* ChannelDispatcher.ChannelDispatcher;
    yield* dispatcher.dispatch(task.taskId, runtime.ownerToken);
    return yield* current(task.taskId);
  });

/** The teammate's message, claimed for a session turn whose launch has not run yet. */
const claimedFromTeammate = (key: string, memoryGrantCeiling?: "read" | "read_write") =>
  Effect.gen(function* () {
    const ledger = yield* ChannelLedger.ChannelLedger;
    const runtime = yield* ChannelRuntime.ChannelRuntime;
    const task = yield* receiveFromTeammate("look: claimed look", key);
    yield* commitTransition(
      ledger,
      (yield* ledger.getTask(task.taskId))!,
      {
        type: "task.dispatch.claimed",
        payload: {
          generation: task.generation,
          target: {
            environmentId,
            projectId,
            modelSelection: botModel,
            runtimeMode: "auto-accept-edits",
            interactionMode: "default",
            workspaceStrategy: { type: "root" },
            ...(memoryGrantCeiling === undefined ? {} : { memoryGrantCeiling }),
          },
          leaseExpiresAt: "2026-10-12T00:00:00.000Z",
        },
      },
      { owner: runtime.ownerToken },
    );
    return (yield* ledger.getTask(task.taskId))!;
  });

describe("GOAT Bot sessions under the requester's current authority", () => {
  it.effect("#2193 recovers a persisted real steer after authority is revoked", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const steering = yield* nextTurnSelectionHarness("channel-session-real-steer");
        const harness = sessionHarness({ workerAdapter: steering.adapter });
        yield* Effect.gen(function* () {
          yield* setupBot;
          yield* linkTeammate;
          let task = yield* dispatchNow(yield* receiveFromTeammate("look: task", "real-steer-1"));
          assert.strictEqual(task.status, "running");
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threadId = task.worker!.threadId;
          harness.world.runs.delete(threadId);
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("real-session-create"),
            threadId,
            projectId: task.target!.projectId,
            title: "Real session",
            modelSelection: task.target!.modelSelection,
            runtimeMode: "auto-accept-edits",
            interactionMode: "default",
            branch: null,
            worktreePath: steering.cwd,
            createdBy: "system",
            creationSource: "server",
          });
          const running = yield* orchestrator.streamDomainEvents.pipe(
            Stream.filter(
              (event) =>
                event.type === "provider-turn.updated" && event.payload.status === "running",
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("real-session-start"),
            threadId,
            messageId: sessionLaunchIdsFor(task.taskId, task.generation).messageId,
            text: "initial request",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "system",
            creationSource: "server",
          });
          yield* worker.drain();
          assert.strictEqual(steering.started.length, 1);
          yield* Fiber.join(running);
          const gateway = yield* ChannelGateway.ChannelGateway;
          const reception = yield* ChannelReceptionService.ChannelReceptionService;
          const ledger = yield* ChannelLedger.ChannelLedger;
          const runtime = yield* ChannelRuntime.ChannelRuntime;
          const runs = (yield* orchestrator.getThreadRecords(threadId, ["runs"])).runs;
          assert.lengthOf(runs, 1);
          yield* commitTransition(
            ledger,
            (yield* ledger.getTask(task.taskId))!,
            {
              type: "task.worker.bound",
              payload: { worker: { ...task.worker!, runId: runs[0]!.id } },
            },
            { owner: runtime.ownerToken },
          );
          task = yield* current(task.taskId);
          const dispatcher = yield* ChannelDispatcher.ChannelDispatcher;
          const threads = yield* ThreadManagement.ThreadManagementService;
          const input = yield* gateway.ingest(
            slackInput(
              "more:" + task.taskId + " check logs",
              "real-steer-2",
              "1760000000.000900",
              "U2",
            ),
            slackContext,
          );
          yield* reception.receive(input.inputId, runtime.ownerToken);
          const ids = turnSteerIdsFor(input.inputId, "first");
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO channel_bot_session_runs
          (thread_id, message_id, task_id, task_generation, kind, created_at)
          VALUES (${task.worker!.threadId}, ${ids.messageId}, ${task.taskId}, ${task.generation}, 'followup', '1970-01-01T00:00:00.000Z')`;
          const sent = yield* threads.sendToThread({
            projectId: task.target!.projectId,
            commandId: ids.commandId,
            threadId: task.worker!.threadId,
            messageId: ids.messageId,
            text: "check logs",
            attachments: [],
            mode: "steer",
            targetRunId: task.worker!.runId!,
            createdBy: "user",
            creationSource: "server",
          });
          assert.strictEqual(sent.delivery, "steered");
          assert.strictEqual(sent.run.id, task.worker!.runId);
          const before = yield* orchestrator.getThreadRecords(task.worker!.threadId, [
            "runs",
            "messages",
          ]);
          assert.strictEqual(
            before.messages.find((message) => message.id === ids.messageId)?.runId,
            task.worker!.runId,
          );
          yield* sql`UPDATE channel_identities SET granted_scopes_json = '[]' WHERE connection_id = 'slack-1' AND external_actor_id = 'U2'`;
          const [pending] = yield* ledger.listPendingForwards(10);
          yield* dispatcher.forward(pending!, runtime.ownerToken);
          const after = yield* orchestrator.getThreadRecords(task.worker!.threadId, [
            "runs",
            "messages",
          ]);
          assert.lengthOf(
            after.messages.filter((message) => message.id === ids.messageId),
            1,
          );
          assert.lengthOf(after.runs, before.runs.length);
          assert.lengthOf((yield* current(task.taskId)).openQuestions, 0);
          assert.isUndefined((yield* ledger.getTask(task.taskId))!.pendingAnswerMessageId);
          assert.lengthOf(yield* ledger.listPendingForwards(10), 0);
          const intents = yield* sql<{
            readonly steered_into_run_id: string | null;
          }>`SELECT steered_into_run_id FROM channel_bot_session_runs WHERE thread_id = ${task.worker!.threadId} AND message_id = ${ids.messageId}`;
          assert.strictEqual(intents[0]?.steered_into_run_id, task.worker!.runId);
        }).pipe(Effect.provide(harness.layer));
      }),
    ),
  );

  it.effect(
    "#2193 preserves the newer session follow-up fence when the earlier one is refused",
    () => {
      const harness = sessionHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        yield* linkTeammate;
        const task = yield* dispatchNow(yield* receiveFromTeammate("look: task", "two-session-1"));
        const gateway = yield* ChannelGateway.ChannelGateway;
        const reception = yield* ChannelReceptionService.ChannelReceptionService;
        const ledger = yield* ChannelLedger.ChannelLedger;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const dispatcher = yield* ChannelDispatcher.ChannelDispatcher;
        const first = yield* gateway.ingest(
          slackInput("more:" + task.taskId + " first", "two-session-2", "1760000000.000900", "U2"),
          slackContext,
        );
        yield* reception.receive(first.inputId, runtime.ownerToken);
        const second = yield* gateway.ingest(
          slackInput("more:" + task.taskId + " second", "two-session-3", "1760000000.000900", "U2"),
          slackContext,
        );
        yield* reception.receive(second.inputId, runtime.ownerToken);
        const [firstForward, secondForward] = yield* ledger.listPendingForwards(10);
        assert.isDefined(firstForward);
        assert.isDefined(secondForward);
        const secondFence = turnSteerIdsFor(second.inputId, "first").messageId;
        assert.strictEqual(
          (yield* ledger.getTask(task.taskId))!.pendingAnswerMessageId,
          secondFence,
        );
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE channel_identities SET granted_scopes_json = '[]' WHERE connection_id = 'slack-1' AND external_actor_id = 'U2'`;
        yield* dispatcher.forward(firstForward!, runtime.ownerToken);
        assert.strictEqual(
          (yield* ledger.getTask(task.taskId))!.pendingAnswerMessageId,
          secondFence,
        );
        assert.lengthOf(yield* ledger.listPendingForwards(10), 1);
        yield* dispatcher.forward(secondForward!, runtime.ownerToken);
        assert.isUndefined((yield* ledger.getTask(task.taskId))!.pendingAnswerMessageId);
        assert.lengthOf(yield* ledger.listPendingForwards(10), 0);
        assert.lengthOf(harness.world.sends, 0);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect.each([
    [true, false, false],
    [false, false, false],
    [true, true, false],
    [false, true, false],
    [true, false, true],
  ] as const)(
    "#2193 drops a revoked answer on a cancelled session task %s",
    ([ownsFence, viaRefusal, failFenceWrite]) => {
      const harness = sessionHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        yield* linkTeammate;
        const task = yield* dispatchNow(
          yield* receiveFromTeammate("look: task", "cancel-session-1"),
        );
        const ledger = yield* ChannelLedger.ChannelLedger;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const dispatcher = yield* ChannelDispatcher.ChannelDispatcher;
        const questionId = ChannelQuestionId.make("question:cancel-session");
        yield* commitTransition(
          ledger,
          (yield* ledger.getTask(task.taskId))!,
          {
            type: "task.question.opened",
            payload: { question: { questionId, text: "Which?", askedAt: task.updatedAt } },
          },
          { owner: runtime.ownerToken },
        );
        const answerEventId = taskEventIdFor(
          task.taskId,
          (yield* ledger.getTask(task.taskId))!.task.version + 1,
        );
        const answerFence = answerForwardIdsFor(answerEventId).messageId;
        const fence = ownsFence ? answerFence : "later-answer-fence";
        yield* commitTransition(
          ledger,
          (yield* ledger.getTask(task.taskId))!,
          {
            type: "task.question.answered",
            payload: { questionId, answer: "the big one" },
          },
          {
            owner: runtime.ownerToken,
            forward: true,
            eventId: answerEventId,
            pendingAnswerMessageId: fence,
          },
        );
        const beforeCancellation = (yield* ledger.getTask(task.taskId))!;
        yield* commitTransition(
          ledger,
          (yield* ledger.getTask(task.taskId))!,
          {
            type: "task.cancelled",
            payload: { reason: "Stopped." },
          },
          { owner: runtime.ownerToken },
        );
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE channel_identities SET granted_scopes_json = '[]' WHERE connection_id = 'slack-1' AND external_actor_id = 'U2'`;
        const [pending] = yield* ledger.listPendingForwards(10);
        assert.strictEqual((yield* ledger.getTask(task.taskId))!.pendingAnswerMessageId, fence);
        if (failFenceWrite) {
          yield* sql`CREATE TEMP TRIGGER fail_answer_fence BEFORE UPDATE OF pending_answer_message_id ON channel_tasks WHEN NEW.pending_answer_message_id IS NULL BEGIN SELECT RAISE(ABORT, 'injected fence failure'); END`;
          const failed = yield* dispatcher
            .forward(pending!, runtime.ownerToken)
            .pipe(Effect.result);
          assert.strictEqual(failed._tag, "Failure");
          assert.isTrue(yield* ledger.isForwardPending(pending!.sequence));
          assert.strictEqual((yield* ledger.getTask(task.taskId))!.pendingAnswerMessageId, fence);
          yield* sql`DROP TRIGGER fail_answer_fence`;
        }
        if (viaRefusal)
          yield* refuseForward(
            ledger,
            beforeCancellation,
            "permission changed",
            runtime.ownerToken,
            pending!.sequence,
            [answerFence],
          );
        else yield* dispatcher.forward(pending!, runtime.ownerToken);
        assert.lengthOf(yield* ledger.listPendingForwards(10), 0);
        assert.strictEqual(
          (yield* ledger.getTask(task.taskId))!.pendingAnswerMessageId,
          ownsFence ? undefined : fence,
        );
        assert.strictEqual((yield* current(task.taskId)).status, "cancelled");
        assert.lengthOf((yield* current(task.taskId)).openQuestions, 0);
        assert.lengthOf(harness.world.sends, 0);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "#2193 rolls back forward completion when the refusal question loses a version race",
    () => {
      const harness = sessionHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        yield* linkTeammate;
        const task = yield* dispatchNow(yield* receiveFromTeammate("look: task", "atomic-1"));
        const gateway = yield* ChannelGateway.ChannelGateway;
        const reception = yield* ChannelReceptionService.ChannelReceptionService;
        const ledger = yield* ChannelLedger.ChannelLedger;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const input = yield* gateway.ingest(
          slackInput("more:" + task.taskId + " logs", "atomic-2", "1760000000.000900", "U2"),
          slackContext,
        );
        yield* reception.receive(input.inputId, runtime.ownerToken);
        const [pending] = yield* ledger.listPendingForwards(10);
        const stored = (yield* ledger.getTask(task.taskId))!;
        const prepared = prepareTransition(
          stored,
          {
            type: "task.question.opened",
            payload: {
              question: {
                questionId: ChannelQuestionId.make("question:atomic"),
                text: "permission changed",
                askedAt: task.updatedAt,
              },
            },
          },
          task.updatedAt,
          undefined,
        );
        assert.isTrue(prepared.ok);
        if (!prepared.ok) return;
        yield* commitTransition(
          ledger,
          stored,
          {
            type: "task.progress",
            payload: { generation: task.generation, summary: "Still running." },
          },
          { owner: runtime.ownerToken },
        );
        const failure = yield* Effect.flip(
          ledger.applyTaskEvent({
            owner: runtime.ownerToken,
            write: prepared.write,
            deliveries: [],
            completeForwardSequence: pending!.sequence,
          }),
        );
        assert.strictEqual(failure.reason, "version_conflict");
        assert.isTrue(yield* ledger.isForwardPending(pending!.sequence));
        assert.lengthOf((yield* current(task.taskId)).openQuestions, 0);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect.each([false, true])(
    "#2193 does not repeat a refused forward when permission is restored: %s",
    (restored) => {
      const harness = sessionHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        yield* linkTeammate;
        const task = yield* dispatchNow(yield* receiveFromTeammate("look: task", "replay-1"));
        const gateway = yield* ChannelGateway.ChannelGateway;
        const reception = yield* ChannelReceptionService.ChannelReceptionService;
        const ledger = yield* ChannelLedger.ChannelLedger;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const dispatcher = yield* ChannelDispatcher.ChannelDispatcher;
        const input = yield* gateway.ingest(
          slackInput("more:" + task.taskId + " check logs", "replay-2", "1760000000.000900", "U2"),
          slackContext,
        );
        yield* reception.receive(input.inputId, runtime.ownerToken);
        const [pending] = yield* ledger.listPendingForwards(10);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE channel_identities SET granted_scopes_json = '[]' WHERE connection_id = 'slack-1' AND external_actor_id = 'U2'`;
        yield* dispatcher.forward(pending!, runtime.ownerToken);
        assert.lengthOf((yield* current(task.taskId)).openQuestions, 1);
        if (restored)
          yield* sql`UPDATE channel_identities SET granted_scopes_json = '["orchestration:read","orchestration:operate"]' WHERE connection_id = 'slack-1' AND external_actor_id = 'U2'`;
        yield* dispatcher.forward(pending!, runtime.ownerToken);
        assert.lengthOf((yield* current(task.taskId)).openQuestions, 1);
        assert.lengthOf(harness.world.sends, 0);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("#2193 recovers an accepted steer after the requester loses authority", () => {
    const harness = sessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* linkTeammate;
      const task = yield* dispatchNow(yield* receiveFromTeammate("look: task", "crash-1"));
      const gateway = yield* ChannelGateway.ChannelGateway;
      const reception = yield* ChannelReceptionService.ChannelReceptionService;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const dispatcher = yield* ChannelDispatcher.ChannelDispatcher;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const input = yield* gateway.ingest(
        slackInput("more:" + task.taskId + " check logs", "crash-2", "1760000000.000900", "U2"),
        slackContext,
      );
      yield* reception.receive(input.inputId, runtime.ownerToken);
      const ids = turnSteerIdsFor(input.inputId, "first");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO channel_bot_session_runs
        (thread_id, message_id, task_id, task_generation, kind, created_at)
        VALUES (${task.worker!.threadId}, ${ids.messageId}, ${task.taskId}, ${task.generation}, 'followup', '1970-01-01T00:00:00.000Z')`;
      yield* threads.sendToThread({
        projectId,
        commandId: ids.commandId,
        threadId: task.worker!.threadId,
        messageId: ids.messageId,
        text: "check logs",
        attachments: [],
        mode: "steer",
        targetRunId: task.worker!.runId!,
        createdBy: "user",
        creationSource: "server",
      });
      const read = threads.getThreadRecords;
      Object.assign(threads, {
        getThreadRecords: ((...args: Parameters<typeof read>) =>
          read(...args).pipe(
            Effect.map((records) => ({
              ...records,
              messages: [
                ...records.messages,
                { id: ids.messageId, runId: task.worker!.runId } as never,
              ],
            })),
          )) as typeof read,
      });
      yield* sql`UPDATE channel_identities SET granted_scopes_json = '[]' WHERE connection_id = 'slack-1' AND external_actor_id = 'U2'`;
      for (const pending of yield* ledger.listPendingForwards(10))
        yield* dispatcher.forward(pending, runtime.ownerToken);
      assert.lengthOf((yield* current(task.taskId)).openQuestions, 0);
      assert.lengthOf(harness.world.sends, 1);
      assert.lengthOf(yield* ledger.listPendingForwards(10), 0);
      assert.isUndefined((yield* ledger.getTask(task.taskId))!.pendingAnswerMessageId);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("#2193 forwards a follow-up under the requester's lowered Slack ceiling", () => {
    const harness = sessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* linkTeammate;
      const task = yield* dispatchNow(yield* receiveFromTeammate("look: task", "ceiling-1"));
      const gateway = yield* ChannelGateway.ChannelGateway;
      const reception = yield* ChannelReceptionService.ChannelReceptionService;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const dispatcher = yield* ChannelDispatcher.ChannelDispatcher;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const send = threads.sendToThread;
      const ceilings: Array<string | undefined> = [];
      Object.assign(threads, {
        sendToThread: (input: Parameters<typeof send>[0]) =>
          Effect.flatMap(DispatchModeLimit, (limit) => {
            ceilings.push(limit?.runtimeMode);
            return send(input);
          }),
      });
      const input = yield* gateway.ingest(
        slackInput("more:" + task.taskId + " check logs", "ceiling-2", "1760000000.000900", "U2"),
        slackContext,
      );
      yield* reception.receive(input.inputId, runtime.ownerToken);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE channel_identities SET runtime_mode_ceiling = 'approval-required' WHERE connection_id = 'slack-1' AND external_actor_id = 'U2'`;
      for (const pending of yield* ledger.listPendingForwards(10))
        yield* dispatcher.forward(pending, runtime.ownerToken);
      assert.isTrue(harness.world.sends.some((entry) => entry.text.includes("check logs")));
      assert.deepStrictEqual(ceilings, ["approval-required"]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("#2193 refuses an answer when the requester's Slack grant is revoked", () => {
    const harness = sessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* linkTeammate;
      const task = yield* dispatchNow(yield* receiveFromTeammate("look: task", "grant-1"));
      const ledger = yield* ChannelLedger.ChannelLedger;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const dispatcher = yield* ChannelDispatcher.ChannelDispatcher;
      const questionId = ChannelQuestionId.make("question:grant");
      yield* commitTransition(
        ledger,
        (yield* ledger.getTask(task.taskId))!,
        {
          type: "task.question.opened",
          payload: {
            question: { questionId, text: "Which?", askedAt: "2026-10-12T00:00:00.000Z" },
          },
        },
        { owner: runtime.ownerToken },
      );
      const gateway = yield* ChannelGateway.ChannelGateway;
      const reception = yield* ChannelReceptionService.ChannelReceptionService;
      const input = yield* gateway.ingest(
        slackInput(
          "answer:" + task.taskId + " " + questionId + " the big one",
          "grant-2",
          "1760000000.000900",
          "U2",
        ),
        slackContext,
      );
      yield* reception.receive(input.inputId, runtime.ownerToken);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE channel_identities SET granted_scopes_json = '[]' WHERE connection_id = 'slack-1' AND external_actor_id = 'U2'`;
      for (const pending of yield* ledger.listPendingForwards(10))
        yield* dispatcher.forward(pending, runtime.ownerToken);
      assert.isFalse(harness.world.sends.some((entry) => entry.text.includes("the big one")));
      const after = yield* current(task.taskId);
      assert.strictEqual(after.status, "waiting_input");
      assert.include(after.openQuestions[0]!.text, "permission");
      assert.isUndefined((yield* ledger.getTask(task.taskId))!.pendingAnswerMessageId);
      assert.lengthOf(yield* ledger.listPendingForwards(10), 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "builds a session's journal from the requester's current scopes, not the ones at intake",
    () => {
      const harness = sessionHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        yield* ask("look: payroll export", "j0");
        yield* linkTeammate;
        const task = yield* receiveFromTeammate("look: check the build", "j1");
        assert.include(task.requester.grantedScopes, "orchestration:read");
        yield* narrowTeammate;
        const served = yield* dispatchNow(task);
        const launch = harness.world.launches.find(
          (candidate) => candidate.threadId === served.worker?.threadId,
        );
        assert.include(launch!.initialMessage!.text, "check the build");
        assert.notInclude(launch!.initialMessage!.text, "payroll export");
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("does not reuse a session whose prefix was built under wider scopes", () => {
    const harness = sessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* ask("look: payroll export", "w0");
      yield* linkTeammate;
      const wide = yield* dispatchNow(yield* receiveFromTeammate("look: first look", "w1"));
      const wideThread = wide.worker!.threadId;
      const wideLaunch = harness.world.launches.find((launch) => launch.threadId === wideThread);
      assert.include(wideLaunch!.initialMessage!.text, "payroll export");
      harness.world.setStatus(wideThread, 1, "completed", "Done.");
      yield* settle;
      yield* narrowTeammate;
      const narrow = yield* dispatchNow(yield* receiveFromTeammate("look: second look", "w2"));
      assert.notStrictEqual(narrow.worker?.threadId, wideThread);
      assert.isFalse(
        harness.world.sends.some(
          (send) => send.threadId === wideThread && JSON.stringify(send).includes("second look"),
        ),
      );
      const narrowLaunch = harness.world.launches.find(
        (launch) => launch.threadId === narrow.worker?.threadId,
      );
      assert.notInclude(narrowLaunch!.initialMessage!.text, "payroll export");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "refuses to start a session for a requester whose link was removed after the task was claimed",
    () => {
      const harness = sessionHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        yield* linkTeammate;
        const stored = yield* claimedFromTeammate("u1");
        const identities = yield* ChannelIdentityService.ChannelIdentityService;
        yield* identities.unlink({ connectionId: "slack-1", externalActorId: "U2" });
        const session = yield* ChannelBotSession.ChannelBotSession;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        assert.strictEqual(yield* session.serve(stored, runtime.ownerToken), "failed");
        const after = yield* current(stored.task.taskId);
        assert.strictEqual(after.status, "failed");
        assert.lengthOf(harness.world.launches, 0);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "starts a session with no more memory than the requester's current scopes allow",
    () => {
      const harness = sessionHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        yield* linkTeammate;
        // The claim recorded memory reads; the teammate's link grants none now.
        const stored = yield* claimedFromTeammate("m1", "read");
        const session = yield* ChannelBotSession.ChannelBotSession;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        assert.strictEqual(yield* session.serve(stored, runtime.ownerToken), "served");
        assert.lengthOf(harness.world.launches, 1);
        assert.isUndefined(harness.world.launches[0]!.initialMessage?.memoryGrantCeiling);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  /** A launch that committed its run but whose pass ended before binding it, as a crash leaves it. */
  const interruptedLaunch = (harness: ReturnType<typeof sessionHarness>, key: string) =>
    Effect.gen(function* () {
      const task = yield* receiveFromTeammate("look: first look", key);
      const thread = goatBotSessionThreadIdFor(task.conversationId as ChannelConversationId, 1);
      harness.world.failLaunchAfterAccept = true;
      harness.world.recordFailures.add(thread);
      const pending = yield* dispatchNow(task);
      harness.world.failLaunchAfterAccept = false;
      assert.isUndefined(pending.worker);
      assert.lengthOf(runsOf(harness, thread), 1);
      return { task, thread };
    });

  const sessionState = (thread: ThreadId) =>
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) =>
        sql<{
          readonly state: string;
        }>`SELECT state FROM channel_bot_sessions WHERE thread_id = ${thread}`,
    ).pipe(Effect.map((rows) => rows[0]?.state));

  it.effect(
    "binds an interrupted launch's run after a narrowing, waiting while its session cannot be read",
    () => {
      const harness = sessionHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        yield* linkTeammate;
        const { task, thread } = yield* interruptedLaunch(harness, "b1");
        yield* narrowTeammate;
        const waiting = yield* dispatchNow(task);
        assert.isUndefined(waiting.worker);
        assert.lengthOf(harness.world.launches, 1);
        harness.world.recordFailures.delete(thread);
        const bound = yield* dispatchNow(task);
        assert.strictEqual(bound.worker?.threadId, thread);
        assert.strictEqual(bound.worker?.runId, runsOf(harness, thread)[0]!.id);
        assert.lengthOf(harness.world.launches, 1);
        assert.lengthOf(harness.world.sends, 0);
        assert.strictEqual(yield* sessionState(thread), "active");
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("binds an interrupted launch's run after the requester's link is removed", () => {
    const harness = sessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* linkTeammate;
      const { task, thread } = yield* interruptedLaunch(harness, "b2");
      const identities = yield* ChannelIdentityService.ChannelIdentityService;
      yield* identities.unlink({ connectionId: "slack-1", externalActorId: "U2" });
      harness.world.recordFailures.delete(thread);
      const bound = yield* dispatchNow(task);
      assert.strictEqual(bound.status, "running");
      assert.strictEqual(bound.worker?.threadId, thread);
      assert.lengthOf(harness.world.launches, 1);
    }).pipe(Effect.provide(harness.layer));
  });
});
