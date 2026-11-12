import { assert, describe, it } from "@effect/vitest";
import { ChannelTaskEventId, MessageId, ProviderInstanceId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServerSettings from "../serverSettings.ts";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelReceptionService from "./ChannelReceptionService.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import * as ChannelDispatcher from "./ChannelDispatcher.ts";
import * as ChannelWorkerReports from "./ChannelWorkerReports.ts";
import { deliveryIdFor } from "./channelIds.ts";
import { taskIdFor } from "./channelIds.ts";
import { noticeRunsOf } from "./testkit/harnessMessages.ts";
import { makeSessionHarness } from "./testkit/ChannelSessionHarness.ts";
import {
  defaultScript,
  goatInput,
  makeHarness,
  rpcContext,
  setupBot,
  makeRuntime,
  botMessages,
  modelSelection,
} from "./testkit/ChannelHarness.ts";

describe("session first receipts", () => {
  it.effect("uses the dispatch fallback binding when the configured bot account is missing", () => {
    const harness = makeHarness({
      botWorkspace: true,
      providerInstances: [{ instanceId: "missing", missing: true }, { instanceId: "codex" }],
      settingsLayer: ServerSettings.layerTest({
        textGenerationModelSelection: modelSelection,
        goatBotModelSelection: {
          instanceId: ProviderInstanceId.make("missing"),
          model: "unavailable",
        },
        defaultRuntimeMode: "full-access",
      }).pipe(Layer.orDie),
    });
    let calls = 0;
    harness.script.current = (input) => {
      calls += 1;
      return defaultScript(input);
    };
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      yield* gateway.ingest(goatInput("Inspect disk", "fallback-binding"), rpcContext);
      yield* runtime.drain;
      assert.strictEqual(calls, 0);
      assert.strictEqual(harness.world.launches[0]?.modelSelection.instanceId, "codex");
    }).pipe(Effect.provide(harness.layer));
  });
  it.effect.each(["same item", "separate item", "fallback"] as const)(
    "direct answer keeps exactly the intended messages: %s",
    (variant) => {
      const harness = makeSessionHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        const gateway = yield* ChannelGateway.ChannelGateway;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const ledger = yield* ChannelLedger.ChannelLedger;
        const input = yield* gateway.ingest(
          goatInput("What is two plus two?", variant),
          rpcContext,
        );
        yield* runtime.drain;
        const stored = yield* ledger.getTask(taskIdFor(input.inputId, 0));
        assert.isDefined(stored?.task.worker);
        const task = stored!.task;
        if (variant === "fallback") {
          yield* TestClock.adjust("20 seconds");
          yield* runtime.expireOverdue;
          yield* runtime.settle([input.inputId]);
        } else {
          harness.assistant(task, variant === "same item" ? "Four." : "Checking.\n", true);
          if (variant === "same item") harness.assistant(task, "Four.");
          yield* runtime.runPass;
          yield* runtime.settle([input.inputId]);
          assert.strictEqual(
            (yield* ledger.getInput(input.inputId))?.snapshot.reply?.text,
            variant === "same item" ? "Four." : "Checking.",
          );
        }
        if (variant !== "same item") harness.assistant(task, "Four.", false, 1);
        harness.world.setStatus(task.worker!.threadId, 1, "completed");
        yield* runtime.drain;
        const { messages } = yield* botMessages;
        const answers = messages.filter((message) => message.text === "Four.");
        assert.lengthOf(answers, 1);
        // Receipt or narrated result, the answer replies to the question it answers.
        assert.strictEqual(answers[0]?.channel?.inReplyToInputId, input.inputId);
        assert.isFalse(messages.some((message) => message.text === "Done."));
        const page = yield* ledger.outcomeDeliveries([task.taskId]);
        assert.strictEqual(page.get(task.taskId), "delivered");
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect.each([
    { first: "Four.", final: "Four.", sent: ["Four."] },
    { first: "42", final: "42", sent: ["42"] },
    { first: "Hi!", final: "Hi! What can I do for you?", sent: ["Hi!", "What can I do for you?"] },
    // Only a repeated whole sentence is dropped, never the start of a different one.
    {
      first: "First step: inspect",
      final: "First step: inspection found nothing.",
      sent: ["First step: inspect", "First step: inspection found nothing."],
    },
    {
      first: "First step: inspect",
      final: "First step: inspect for credentials.",
      sent: ["First step: inspect", "First step: inspect for credentials."],
    },
  ])(
    "a first line that already answered is not sent again by the final message: $final",
    ({ first, final, sent }) => {
      const harness = makeSessionHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        const gateway = yield* ChannelGateway.ChannelGateway;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const ledger = yield* ChannelLedger.ChannelLedger;
        const input = yield* gateway.ingest(goatInput("Say hi", "restated-" + first), rpcContext);
        yield* runtime.drain;
        const task = (yield* ledger.getTask(taskIdFor(input.inputId, 0)))!.task;
        // The session answers in its first line, reports, then closes with a message of its own.
        harness.assistant(task, first, false, 0);
        yield* runtime.runPass;
        yield* runtime.settle([input.inputId]);
        harness.assistant(task, final, false, 2);
        harness.world.setStatus(task.worker!.threadId, 1, "completed");
        yield* runtime.drain;
        const { messages } = yield* botMessages;
        const replies = messages
          .filter((message) => message.channel?.inReplyToInputId === input.inputId)
          .map((message) => message.text);
        assert.deepStrictEqual(replies, sent);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("a run reconciled before its receipt commits still sends its answer once", () => {
    const harness = makeSessionHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      const input = yield* gateway.ingest(goatInput("What is two plus two?", "race"), rpcContext);
      yield* runtime.drain;
      const task = (yield* ledger.getTask(taskIdFor(input.inputId, 0)))!.task;
      harness.assistant(task, "Four.");
      harness.world.setStatus(task.worker!.threadId, 1, "completed");
      // The worker pass sees the finished run before the observer commits its first line.
      yield* reports.reconcile(runtime.ownerToken);
      assert.strictEqual((yield* ledger.getTask(task.taskId))?.task.status, "running");
      yield* runtime.drain;
      yield* runtime.settle([input.inputId]);
      yield* runtime.drain;
      const { messages } = yield* botMessages;
      assert.lengthOf(
        messages.filter((message) => message.text === "Four."),
        1,
      );
      assert.isFalse(messages.some((message) => message.text === "Done."));
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "a background command's notice, NO_REPLY included, never becomes the first reply",
    () => {
      const harness = makeSessionHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        const gateway = yield* ChannelGateway.ChannelGateway;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const ledger = yield* ChannelLedger.ChannelLedger;
        const input = yield* gateway.ingest(
          goatInput("What is two plus two?", "notice"),
          rpcContext,
        );
        yield* runtime.drain;
        const task = (yield* ledger.getTask(taskIdFor(input.inputId, 0)))!.task;
        const worker = task.worker!;
        const notice = harness.world.addRun(worker.threadId, MessageId.make("message:notice"));
        const own = worker.runId;
        if (own === undefined) throw new Error("The task has no session run");
        noticeRunsOf(harness.world).set(notice.id, own);
        harness.assistant(
          { ...task, worker: { ...worker, runId: notice.id } },
          "NO_REPLY",
          false,
          3,
        );
        yield* runtime.runPass;
        assert.isUndefined((yield* ledger.getInput(input.inputId))?.snapshot.reply);
        harness.assistant(task, "Four.", false, 1);
        yield* runtime.runPass;
        assert.strictEqual((yield* ledger.getInput(input.inputId))?.snapshot.reply?.text, "Four.");
        const { messages } = yield* botMessages;
        assert.isFalse(messages.some((message) => message.text.includes("NO_REPLY")));
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("a claim before dispatch survives a runtime restart as one turn", () => {
    const harness = makeHarness({ botWorkspace: true });
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const dispatcher = yield* ChannelDispatcher.ChannelDispatcher;
      const runtime = yield* makeRuntime.pipe(
        Effect.provideService(ChannelDispatcher.ChannelDispatcher, {
          ...dispatcher,
          dispatch: () => Effect.void,
        }),
      );
      const ledger = yield* ChannelLedger.ChannelLedger;
      const input = yield* gateway.ingest(goatInput("Inspect this machine", "restart"), rpcContext);
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* ledger.claimOwnership({ token: runtime.ownerToken, now, staleBefore: now });
      yield* runtime.runPass;
      yield* runtime.settle([input.inputId]);
      assert.strictEqual(
        (yield* ledger.getInput(input.inputId))?.snapshot.receptionId,
        "channel-session:" + input.inputId,
      );
      assert.lengthOf(harness.world.launches, 0);
      assert.strictEqual(
        (yield* ledger.getTask(taskIdFor(input.inputId, 0)))?.task.status,
        "received",
      );
      const restarted = yield* makeRuntime;
      yield* TestClock.adjust("31 seconds");
      yield* restarted.drain;
      assert.strictEqual((yield* ledger.getTask(taskIdFor(input.inputId, 0)))?.task.kind, "turn");
      assert.lengthOf(harness.world.launches, 1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("a silent session gets acknowledgment-only reception at 20 seconds", () => {
    const harness = makeHarness({ botWorkspace: true });
    const modes: string[] = [];
    harness.script.current = (input) => {
      modes.push(input.mode);
      return defaultScript(input);
    };
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const input = yield* gateway.ingest(goatInput("Inspect this machine", "silent"), rpcContext);
      yield* runtime.drain;
      assert.isUndefined((yield* ledger.getInput(input.inputId))?.snapshot.reply);
      yield* TestClock.adjust("20 seconds");
      yield* runtime.expireOverdue;
      yield* runtime.settle([input.inputId]);
      assert.deepStrictEqual(modes, ["task_event"]);
      assert.isDefined((yield* ledger.getInput(input.inputId))?.snapshot.reply);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("offers an idle per-run session the request without calling reception", () => {
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
      yield* gateway.ingest(goatInput("What is two plus two?", "session-first"), rpcContext);
      yield* runtime.drain;
      assert.strictEqual(calls, 0);
      assert.lengthOf(harness.world.launches, 1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "a session-first message reads as read and its receipt names the task it started",
    () => {
      const harness = makeSessionHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        const gateway = yield* ChannelGateway.ChannelGateway;
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const ledger = yield* ChannelLedger.ChannelLedger;
        const input = yield* gateway.ingest(
          goatInput("Inspect disk usage", "indicator"),
          rpcContext,
        );
        yield* runtime.drain;
        const task = (yield* ledger.getTask(taskIdFor(input.inputId, 0)))!.task;
        // The client shows "Reading your message" from the read time on the bot's copy.
        const before = yield* botMessages;
        const inbound = before.messages.find((message) => message.role === "user");
        assert.strictEqual(inbound?.channel?.inputId, input.inputId);
        const readAt = (yield* ledger.getInput(input.inputId))?.snapshot.readAt;
        assert.isDefined(readAt);
        assert.strictEqual(inbound?.channel?.readAt, readAt);

        harness.assistant(task, "Checking the disks now.\n", true);
        yield* runtime.runPass;
        yield* runtime.settle([input.inputId]);
        yield* runtime.drain;
        // The client follows the task an acknowledgement names while its card is outstanding.
        const after = yield* botMessages;
        const receipt = after.messages.find(
          (message) => message.role === "assistant" && message.text === "Checking the disks now.",
        );
        assert.strictEqual(receipt?.channel?.inReplyToInputId, input.inputId);
        assert.strictEqual(receipt?.channel?.taskId, task.taskId);
        const chip = after.turnItems
          .flatMap((item) =>
            item.type === "notification" && item.ledgerTask ? [item.ledgerTask] : [],
          )
          .findLast((entry) => entry.taskId === task.taskId);
        assert.oneOf(chip?.status, ["received", "dispatching", "running", "waiting_input"]);
        // Clients keep the bot's own turns out of the conversation's task cards by this field.
        assert.strictEqual(chip?.kind, "turn");
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("a silent session's acknowledgment names the task it started", () => {
    const harness = makeHarness({ botWorkspace: true });
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const input = yield* gateway.ingest(
        goatInput("Inspect this machine", "silent-ack"),
        rpcContext,
      );
      yield* runtime.drain;
      yield* TestClock.adjust("20 seconds");
      yield* runtime.expireOverdue;
      yield* runtime.settle([input.inputId]);
      yield* runtime.drain;
      const { messages } = yield* botMessages;
      const receipt = messages.find(
        (message) =>
          message.role === "assistant" && message.channel?.inReplyToInputId === input.inputId,
      );
      assert.strictEqual(receipt?.channel?.taskId, taskIdFor(input.inputId, 0));
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("holds task-only outbox rows when their origin receipt is missing", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const reception = yield* ChannelReceptionService.ChannelReceptionService;
      const sql = yield* SqlClient.SqlClient;
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* ledger.claimOwnership({ token: "test", now, staleBefore: now });
      const input = yield* gateway.ingest(goatInput("do: inspect disk", "missing"), rpcContext);
      yield* reception.receive(input.inputId, "test");
      yield* sql`DELETE FROM channel_outbox WHERE cause_key = ${"reply:" + input.inputId}`;
      const claimed = yield* ledger.claimDueDeliveries({ owner: "test", now, limit: 100 });
      assert.lengthOf(claimed, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("a late retry result cannot reopen a terminal receipt", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const reception = yield* ChannelReceptionService.ChannelReceptionService;
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* ledger.claimOwnership({ token: "test", now, staleBefore: now });
      const input = yield* gateway.ingest(goatInput("hello", "late"), rpcContext);
      yield* reception.receive(input.inputId, "test");
      yield* ledger.claimDueDeliveries({ owner: "test", now, limit: 100 });
      const deliveryId = deliveryIdFor("reply:" + input.inputId);
      yield* ledger.recordDelivery({
        owner: "test",
        deliveryId,
        now,
        outcome: { type: "ambiguous", errorCode: "deadline" },
      });
      yield* ledger.recordDelivery({
        owner: "test",
        deliveryId,
        now,
        outcome: { type: "retry", at: now, errorCode: "late" },
      });
      assert.strictEqual(yield* ledger.getDeliveryState(deliveryId), "ambiguous");
    }).pipe(Effect.provide(harness.layer));
  });
});

describe("a GOAT Bot turn that asked the person", () => {
  /** A session turn asks with channel_task_report, then its run ends waiting for the answer. */
  const askingTurn = (harness: ReturnType<typeof makeSessionHarness>) =>
    Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const reports = yield* ChannelWorkerReports.ChannelWorkerReports;
      const input = yield* gateway.ingest(goatInput("Kill the server on 3774", "asks"), rpcContext);
      yield* runtime.drain;
      const turn = (yield* ledger.getTask(taskIdFor(input.inputId, 0)))!.task;
      yield* reports.report(
        {
          taskId: turn.taskId,
          eventId: ChannelTaskEventId.make("turn-asks"),
          generation: turn.generation,
          status: "waiting_input",
          summary: "Confirming first.",
          question: "That is GOAT itself. Kill it anyway?",
        },
        turn.worker!.threadId,
      );
      harness.world.setStatus(turn.worker!.threadId, 1, "completed");
      yield* runtime.drain;
      const waiting = (yield* ledger.getTask(turn.taskId))!.task;
      assert.strictEqual(waiting.status, "waiting_input");
      return { turn, question: waiting.openQuestions[0]! };
    });

  /** The person's next message, run by the session as its own turn and still going. */
  const nextMessage = (text: string) =>
    Effect.gen(function* () {
      const gateway = yield* ChannelGateway.ChannelGateway;
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const ledger = yield* ChannelLedger.ChannelLedger;
      yield* TestClock.adjust("1 minute");
      const input = yield* gateway.ingest(goatInput(text, "next"), rpcContext);
      yield* runtime.drain;
      const turn = (yield* ledger.getTask(taskIdFor(input.inputId, 0)))!.task;
      assert.isDefined(turn.worker);
      return turn;
    });

  it.effect(
    "regression: once the session has taken the next message, the question closes without naming it the answer",
    () => {
      const harness = makeSessionHarness();
      return Effect.gen(function* () {
        const { turn, question } = yield* askingTurn(harness);
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const ledger = yield* ChannelLedger.ChannelLedger;
        const next = yield* nextMessage("what is the weather tomorrow?");
        // While the next turn runs, the session has not answered or asked again yet.
        assert.strictEqual((yield* ledger.getTask(turn.taskId))!.task.status, "waiting_input");
        harness.world.setStatus(next.worker!.threadId, 2, "completed");
        // The next turn ends once its first line is sealed, here by the fallback receipt.
        yield* TestClock.adjust("20 seconds");
        yield* runtime.expireOverdue;
        yield* runtime.settle([next.originInputId]);
        yield* runtime.drain;
        assert.strictEqual((yield* ledger.getTask(next.taskId))!.task.status, "completed");
        const asked = (yield* ledger.getTask(turn.taskId))!.task;
        assert.strictEqual(asked.status, "completed");
        assert.deepStrictEqual(asked.openQuestions, []);
        // An unrelated message is never recorded as the answer to the question.
        assert.deepStrictEqual(asked.answeredQuestions, [{ questionId: question.questionId }]);
        const { messages } = yield* botMessages;
        assert.lengthOf(
          messages.filter((message) => message.text.includes("Kill it anyway?")),
          1,
        );
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect.each(["failed", "cancelled"] as const)(
    "keeps the question open when the next message's turn %s before the session took it",
    (status) => {
      const harness = makeSessionHarness();
      return Effect.gen(function* () {
        const { turn } = yield* askingTurn(harness);
        const runtime = yield* ChannelRuntime.ChannelRuntime;
        const ledger = yield* ChannelLedger.ChannelLedger;
        const next = yield* nextMessage("yes, kill it");
        harness.world.setStatus(next.worker!.threadId, 2, status);
        yield* runtime.drain;
        assert.notStrictEqual((yield* ledger.getTask(next.taskId))!.task.status, "running");
        const waiting = (yield* ledger.getTask(turn.taskId))!.task;
        assert.strictEqual(waiting.status, "waiting_input");
        assert.lengthOf(waiting.openQuestions, 1);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("keeps waiting while nothing newer came from the person who was asked", () => {
    const harness = makeSessionHarness();
    return Effect.gen(function* () {
      const { turn } = yield* askingTurn(harness);
      const runtime = yield* ChannelRuntime.ChannelRuntime;
      const ledger = yield* ChannelLedger.ChannelLedger;
      yield* TestClock.adjust("1 hour");
      yield* runtime.drain;
      const waiting = (yield* ledger.getTask(turn.taskId))!.task;
      assert.strictEqual(waiting.status, "waiting_input");
      assert.lengthOf(waiting.openQuestions, 1);
    }).pipe(Effect.provide(harness.layer));
  });
});
