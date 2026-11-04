import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, RunId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as ChannelDispatcher from "../../../channels/ChannelDispatcher.ts";
import * as ChannelLedger from "../../../channels/ChannelLedger.ts";
import * as ChannelRuntime from "../../../channels/ChannelRuntime.ts";
import { commitTransition } from "../../../channels/channelTaskWrites.ts";
import { ChannelQuestionId } from "@goat/contracts";
import * as ChannelSessionTaskActions from "../../../channels/channelSessionTaskActions.ts";
import { ask, runsOf, sessionHarness } from "../../../channels/ChannelBotSession.testkit.ts";
import { setupBot } from "../../../channels/testkit/ChannelHarness.ts";
import { environmentId, makeHarness } from "../../../channels/testkit/ChannelHarness.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as ChannelHandlers from "./handlers.ts";
import { ChannelToolkit } from "./tools.ts";

it.effect("a non-bot thread cannot steer a channel task", () => {
  const harness = makeHarness();
  const scope = Layer.succeed(McpInvocationContext.McpInvocationContext, {
    environmentId,
    capabilities: new Set(["orchestration"] as const),
    issuedAt: 0,
    requestNamespace: "non-bot",
    grantedScopes: ["orchestration:operate" as const],
    thread: {
      threadId: ThreadId.make("thread:ordinary"),
      runId: RunId.make("run:ordinary"),
      providerSessionId: "provider:ordinary",
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
    client: undefined,
  });
  return Effect.gen(function* () {
    const toolkit = yield* ChannelToolkit.pipe(
      Effect.provide(McpToolAccess.HandlersLayer.layer(ChannelHandlers.layer)),
    );
    const result = yield* toolkit
      .handle("channel_task_follow_up", {
        taskId: "task:foreign",
        text: "continue",
        clientRequestId: "one",
      })
      .pipe(Stream.unwrap, Stream.runCollect);
    const failure = result.at(-1)!.result;
    assert.isNotNull(failure);
    if (failure === null) return;
    assert.isTrue("code" in failure);
    if ("code" in failure) assert.strictEqual(failure.code, "capability_denied");
  }).pipe(Effect.provide(Layer.merge(scope, harness.layer)));
});

it.effect(
  "a session run follows up idempotently and refuses retired or steered-only intents",
  () => {
    const harness = sessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const source = yield* ask("look: source", "session-actions-source");
      const target = yield* ask("look: target", "session-actions-target");
      const threadId = source.worker!.threadId;
      const runId = runsOf(harness, threadId)[0]!.id;
      const caller = { threadId, runId };
      const actions = yield* ChannelSessionTaskActions.ChannelSessionTaskActions;
      const first = yield* actions.followUp({
        caller,
        taskId: target.taskId,
        text: "continue",
        clientRequestId: "one",
      });
      assert.strictEqual(first?.type, "task.followup.received");
      if (first?.type !== "task.followup.received") return yield* Effect.die("expected follow-up");
      assert.isString(first.payload.forwardKey);
      const again = yield* actions.followUp({
        caller,
        taskId: target.taskId,
        text: "ignored",
        clientRequestId: "one",
      });
      const ledger = yield* ChannelLedger.ChannelLedger;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const dispatcher = yield* ChannelDispatcher.ChannelDispatcher;
      for (const pending of yield* ledger.listPendingForwards(10))
        yield* dispatcher.forward(pending, runtime.ownerToken);
      const sent = harness.world.sends.filter((send) => send.text.includes("continue"));
      assert.lengthOf(sent, 1);
      assert.deepStrictEqual(sent[0]!.attachments, []);
      const second = yield* actions.followUp({
        caller,
        taskId: target.taskId,
        text: "again",
        clientRequestId: "two",
      });
      assert.deepStrictEqual(again, first);
      assert.notStrictEqual(first?.eventId, second?.eventId);
      const sql = yield* SqlClient.SqlClient;
      const events = yield* sql<{
        readonly count: number;
      }>`SELECT count(*) AS count FROM channel_task_events WHERE task_id = ${target.taskId} AND type = 'task.followup.received'`;
      assert.strictEqual(events[0]!.count, 2);
      yield* sql`UPDATE channel_bot_session_runs SET run_id = NULL, steered_into_run_id = ${runId} WHERE thread_id = ${threadId} AND run_id = ${runId}`;
      assert.strictEqual(
        (yield* Effect.flip(
          actions.followUp({ caller, taskId: target.taskId, text: "x", clientRequestId: "three" }),
        )).reason,
        "forbidden",
      );
      yield* sql`UPDATE channel_bot_session_runs SET run_id = ${runId} WHERE thread_id = ${threadId} AND steered_into_run_id = ${runId}`;
      yield* sql`UPDATE channel_bot_sessions SET state = 'retired' WHERE thread_id = ${threadId}`;
      assert.strictEqual(
        (yield* Effect.flip(actions.stop({ caller, taskId: target.taskId }))).reason,
        "forbidden",
      );
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect(
  "session task actions hide foreign tasks, record answers, and cascade a stop once",
  () => {
    const harness = sessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const source = yield* ask("look: source", "actions2-source");
      const target = yield* ask("look: target", "actions2-target");
      const threadId = source.worker!.threadId;
      const runId = runsOf(harness, threadId)[0]!.id;
      const caller = { threadId, runId };
      const actions = yield* ChannelSessionTaskActions.ChannelSessionTaskActions;
      const sql = yield* SqlClient.SqlClient;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      yield* sql`UPDATE channel_tasks SET owner_id = 'foreign' WHERE task_id = ${target.taskId}`;
      assert.strictEqual(
        (yield* Effect.flip(actions.stop({ caller, taskId: target.taskId }))).reason,
        "not_found",
      );
      yield* sql`UPDATE channel_tasks SET owner_id = ${source.requester.ownerId}, task_json = json_set(task_json, '$.conversationId', 'foreign') WHERE task_id = ${target.taskId}`;
      assert.strictEqual(
        (yield* Effect.flip(actions.stop({ caller, taskId: target.taskId }))).reason,
        "not_found",
      );
      yield* sql`UPDATE channel_tasks SET task_json = json_set(task_json, '$.conversationId', ${source.conversationId}) WHERE task_id = ${target.taskId}`;
      const questionId = ChannelQuestionId.make("session-action-question");
      yield* commitTransition(
        ledger,
        (yield* ledger.getTask(target.taskId))!,
        {
          type: "task.question.opened",
          payload: {
            question: { questionId, text: "Which?", askedAt: "2026-10-12T00:00:00.000Z" },
          },
        },
        { owner: runtime.ownerToken },
      );
      const answer = yield* actions.answer({
        caller,
        taskId: target.taskId,
        questionId,
        answer: "one",
      });
      assert.strictEqual(answer?.type, "task.question.answered");
      assert.deepStrictEqual(
        yield* actions.answer({ caller, taskId: target.taskId, questionId, answer: "two" }),
        answer,
      );
      harness.world.subagents.set(threadId, [
        {
          id: "node:child",
          runId,
          origin: "app_owned",
          childThreadId: "thread:child",
          status: "running",
          completionDelivery: { state: "pending" },
        },
      ] as never);
      const stopped = yield* actions.stop({ caller, taskId: source.taskId });
      assert.strictEqual(stopped?.type, "task.cancelled");
      assert.isNull(yield* actions.stop({ caller, taskId: source.taskId }));
      const dispatcher = yield* ChannelDispatcher.ChannelDispatcher;
      for (const pending of yield* ledger.listPendingForwards(10))
        yield* dispatcher.forward(pending, runtime.ownerToken);
      assert.isTrue(
        harness.world.commands.some(
          (command) => command.type === "run.interrupt" && command.runId === runId,
        ),
      );
      assert.deepStrictEqual(harness.world.childStops, [
        { threadId, childThreadIds: ["thread:child"] },
      ]);
    }).pipe(Effect.provide(harness.layer));
  },
);
