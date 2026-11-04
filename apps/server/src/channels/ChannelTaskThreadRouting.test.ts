import { assert, it } from "@effect/vitest";
import { ChannelQuestionId, ChannelTaskId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as ServerSettings from "../serverSettings.ts";
import * as ChannelSessionFirst from "./ChannelSessionFirst.ts";
import { makeCreatedTasks } from "./channelTaskWrites.ts";
import { prepareDeliveryTask } from "./testkit/channelLedgerFixtures.ts";
import * as ChannelReceptionService from "./ChannelReceptionService.ts";
import * as SqlClient from "effect/sql/SqlClient";
import * as ChannelLedger from "./ChannelLedger.ts";
import { taskIdFor } from "./channelIds.ts";
import { makeSessionHarness } from "./testkit/ChannelSessionHarness.ts";
import { commitTransition } from "./channelTaskWrites.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import {
  botMessages,
  defaultScript,
  goatInput,
  makeHarness,
  rpcContext,
  setupBot,
} from "./testkit/ChannelHarness.ts";

it.effect("refuses an unknown task thread without invoking reception or a session", () => {
  const harness = makeHarness({ botWorkspace: true });
  let calls = 0;
  harness.script.current = (input) => {
    calls += 1;
    return defaultScript(input);
  };
  return Effect.gen(function* () {
    yield* setupBot;
    const gateway = yield* ChannelGateway.ChannelGateway;
    const runtime = yield* ChannelRuntime.ChannelRuntime;
    const taskId = ChannelTaskId.make("unknown-task");
    const input = yield* gateway.ingest(
      { ...goatInput("Hello", "unknown-task"), taskId },
      rpcContext,
    );
    yield* runtime.drain;
    const { messages } = yield* botMessages;
    const reply = messages.find((message) => message.channel?.inReplyToInputId === input.inputId);
    assert.strictEqual(reply?.text, "That task isn't available here. Send it in the main chat.");
    assert.isUndefined(reply?.channel?.taskId);
    assert.strictEqual(calls, 0);
    assert.lengthOf(harness.world.launches, 0);
  }).pipe(Effect.provide(harness.layer));
});

it.effect.each(["running", "waiting_input"] as const)(
  "forwards a task-thread message once while %s",
  (status) => {
    const harness = makeSessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const sql = yield* SqlClient.SqlClient;
      const first = yield* gateway.ingest(goatInput("Inspect disks", "original"), rpcContext);
      yield* runtime.drain;
      const task = (yield* ledger.getTask(taskIdFor(first.inputId, 0)))!.task;
      assert.strictEqual(task.status, "running");
      harness.assistant(task, "Working on it.");
      yield* runtime.drain;
      if (status === "waiting_input") {
        yield* commitTransition(
          ledger,
          (yield* ledger.getTask(task.taskId))!,
          {
            type: "task.question.opened",
            payload: {
              question: {
                questionId: ChannelQuestionId.make("question-1"),
                text: "Which?",
                askedAt: task.updatedAt,
              },
            },
          },
          { owner: runtime.ownerToken },
        );
      }
      const message = { ...goatInput("Check the logs too", "followup"), taskId: task.taskId };
      const input = yield* gateway.ingest(message, rpcContext);
      yield* runtime.drain;
      yield* gateway.ingest(message, rpcContext);
      yield* runtime.drain;
      const rows = yield* sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM channel_task_events WHERE task_id = ${task.taskId} AND type = 'task.followup.received'`;
      assert.strictEqual(rows[0]?.count, 1);
      const sends = harness.world.sends.filter((send) => send.text.includes("Check the logs too"));
      assert.lengthOf(sends, 1);
      assert.strictEqual(sends[0]?.threadId, task.worker?.threadId);
      assert.strictEqual(sends[0]?.targetRunId, task.worker?.runId);
      const { messages } = yield* botMessages;
      assert.strictEqual(
        messages.find((m) => m.channel?.inputId === input.inputId)?.channel?.taskId,
        task.taskId,
      );
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect("a terminal task starts a session turn with task context and a task-tagged reply", () => {
  const harness = makeSessionHarness();
  return Effect.gen(function* () {
    yield* setupBot;
    const gateway = yield* ChannelGateway.ChannelGateway;
    const runtime = yield* ChannelRuntime.ChannelRuntime;
    const ledger = yield* ChannelLedger.ChannelLedger;
    const first = yield* gateway.ingest(
      goatInput("Inspect disks", "terminal-original"),
      rpcContext,
    );
    yield* runtime.drain;
    const task = (yield* ledger.getTask(taskIdFor(first.inputId, 0)))!.task;
    harness.assistant(task, "Working.");
    yield* runtime.drain;
    yield* commitTransition(
      ledger,
      (yield* ledger.getTask(task.taskId))!,
      {
        type: "task.completed",
        payload: { generation: task.generation, summary: "Disk is healthy" },
      },
      { owner: runtime.ownerToken },
    );
    const next = yield* gateway.ingest(
      { ...goatInput("Explain the result", "terminal-next"), taskId: task.taskId },
      rpcContext,
    );
    yield* runtime.drain;
    const turn = (yield* ledger.getTask(taskIdFor(next.inputId, 0)))!.task;
    assert.include(turn.instruction, task.taskId);
    assert.include(turn.instruction, task.title);
    assert.include(turn.instruction, "completed");
    assert.include(turn.instruction, "Disk is healthy");
    harness.assistant(turn, "The disk is healthy.");
    yield* runtime.drain;
    const { messages } = yield* botMessages;
    assert.strictEqual(
      messages.find((m) => m.channel?.inReplyToInputId === next.inputId)?.channel?.taskId,
      task.taskId,
    );
  }).pipe(Effect.provide(harness.layer));
});

it.effect.each(["owner", "conversation", "authority", "remote-worker"] as const)(
  "refuses a task from a different %s",
  (field) => {
    const harness = makeSessionHarness();
    let calls = 0;
    harness.script.current = (input) => {
      calls += 1;
      return defaultScript(input);
    };
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const sql = yield* SqlClient.SqlClient;
      const first = yield* gateway.ingest(goatInput("Inspect disks", "scope-original"), rpcContext);
      yield* runtime.drain;
      const task = (yield* ledger.getTask(taskIdFor(first.inputId, 0)))!.task;
      harness.assistant(task, "Working.");
      yield* runtime.drain;
      if (field === "owner")
        yield* sql`UPDATE channel_tasks SET owner_id = 'other-owner' WHERE task_id = ${task.taskId}`;
      else if (field === "conversation")
        yield* sql`UPDATE channel_tasks SET task_json = json_set(task_json, '$.conversationId', 'other-conversation') WHERE task_id = ${task.taskId}`;
      else if (field === "remote-worker")
        yield* sql`UPDATE channel_tasks SET task_json = json_set(task_json, '$.worker.host', 'remote') WHERE task_id = ${task.taskId}`;
      const launches = harness.world.launches.length;
      const input = yield* gateway.ingest(
        { ...goatInput("Hello", "scope-target"), taskId: task.taskId },
        field === "authority"
          ? { ...rpcContext, runtimeModeCeiling: "approval-required" }
          : rpcContext,
      );
      yield* runtime.drain;
      const { messages } = yield* botMessages;
      const reply = messages.find((m) => m.channel?.inReplyToInputId === input.inputId);
      assert.strictEqual(reply?.text, "That task isn't available here. Send it in the main chat.");
      assert.strictEqual(
        reply?.channel?.taskId,
        field === "remote-worker" ? task.taskId : undefined,
      );
      assert.strictEqual(
        messages.find((m) => m.channel?.inputId === input.inputId)?.channel?.taskId,
        field === "remote-worker" ? task.taskId : undefined,
      );
      assert.strictEqual(calls, 0);
      assert.lengthOf(harness.world.launches, launches);
      assert.lengthOf(harness.world.sends, 0);
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect("reception directly refuses a task-thread message without calling its classifier", () => {
  const harness = makeHarness();
  let calls = 0;
  harness.script.current = (input) => {
    calls += 1;
    return defaultScript(input);
  };
  return Effect.gen(function* () {
    yield* setupBot;
    const gateway = yield* ChannelGateway.ChannelGateway;
    const ledger = yield* ChannelLedger.ChannelLedger;
    const reception = yield* ChannelReceptionService.ChannelReceptionService;
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* ledger.claimOwnership({ token: "test", now, staleBefore: now });
    const input = yield* gateway.ingest(
      { ...goatInput("Hello", "direct-reception"), taskId: ChannelTaskId.make("missing") },
      rpcContext,
    );
    yield* reception.receive(input.inputId, "test");
    assert.strictEqual(
      (yield* ledger.getInput(input.inputId))?.snapshot.reply?.text,
      "That task isn't available here. Send it in the main chat.",
    );
    assert.strictEqual(calls, 0);
  }).pipe(Effect.provide(harness.layer));
});

it.effect.each(["received", "dispatching"] as const)(
  "says a %s task is still starting",
  (status) => {
    const harness = makeSessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const session = yield* ChannelSessionFirst.ChannelSessionFirst;
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* ledger.claimOwnership({ token: "test", now, staleBefore: now });
      const original = yield* gateway.ingest(goatInput("Inspect", "starting-original"), rpcContext);
      const stored = (yield* ledger.getInput(original.inputId))!;
      const [created] = makeCreatedTasks({
        action: { type: "create_task", title: "Inspect", instruction: "Inspect" },
        inputId: original.inputId,
        conversationId: stored.snapshot.conversationId,
        originBindingId: stored.snapshot.bindingId,
        originAddress: stored.message.replyAddress,
        requester: stored.requester!,
        now,
      });
      yield* prepareDeliveryTask(original, created!, "test", now);
      if (status === "dispatching") {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE channel_tasks SET status = 'dispatching', task_json = json_set(task_json, '$.status', 'dispatching') WHERE task_id = ${created!.task.taskId}`;
      }
      const next = yield* gateway.ingest(
        { ...goatInput("Hello", "starting-next"), taskId: created!.task.taskId },
        rpcContext,
      );
      yield* session.offer(next.inputId, "test");
      assert.strictEqual(
        (yield* ledger.getInput(next.inputId))?.snapshot.reply?.text,
        "That task is still starting. Try again in a moment.",
      );
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect.each(["reception", "choice", "label"] as const)(
  "routes a terminal task %s message as main chat",
  (mode) => {
    const harness = makeSessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const settings = yield* ServerSettings.ServerSettingsService;
      const first = yield* gateway.ingest(
        goatInput("Inspect disks", `route-original-${mode}`),
        rpcContext,
      );
      yield* runtime.drain;
      const task = (yield* ledger.getTask(taskIdFor(first.inputId, 0)))!.task;
      harness.assistant(task, "Working.");
      yield* runtime.drain;
      yield* commitTransition(
        ledger,
        (yield* ledger.getTask(task.taskId))!,
        { type: "task.completed", payload: { generation: task.generation, summary: "Done" } },
        { owner: runtime.ownerToken },
      );
      if (mode === "label") {
        const other = yield* gateway.ingest(goatInput("Other work", "other-work"), rpcContext);
        yield* runtime.drain;
        const otherTask = (yield* ledger.getTask(taskIdFor(other.inputId, 0)))!.task;
        harness.assistant(otherTask, "Waiting.");
        yield* runtime.drain;
        yield* commitTransition(
          ledger,
          (yield* ledger.getTask(otherTask.taskId))!,
          {
            type: "task.question.opened",
            payload: {
              question: {
                questionId: ChannelQuestionId.make("other-question"),
                text: "Which?",
                options: ["Blue", "Red"],
                askedAt: otherTask.updatedAt,
              },
            },
          },
          { owner: runtime.ownerToken },
        );
      }
      if (mode === "reception")
        yield* settings.updateSettings({ goatBotSessionRouting: "reception" });
      const next = yield* gateway.ingest(
        {
          ...goatInput(
            mode === "choice" ? "approve" : mode === "label" ? "Blue" : "Explain",
            `route-next-${mode}`,
          ),
          taskId: task.taskId,
        },
        rpcContext,
      );
      yield* runtime.drain;
      const received = yield* ledger.getInput(next.inputId);
      assert.match(
        received?.snapshot.receptionId ?? "",
        mode === "reception" ? /^channel-reception:/u : /^channel-session:/u,
      );
      assert.notStrictEqual(
        received?.snapshot.reply?.text,
        "That task isn't available here. Send it in the main chat.",
      );
      const { messages } = yield* botMessages;
      assert.isUndefined(
        messages.find((message) => message.channel?.inputId === next.inputId)?.channel?.taskId,
      );
      if (mode !== "reception") {
        const turn = (yield* ledger.getTask(taskIdFor(next.inputId, 0)))!.task;
        assert.notInclude(turn.instruction, task.taskId);
      }
    }).pipe(Effect.provide(harness.layer));
  },
);
