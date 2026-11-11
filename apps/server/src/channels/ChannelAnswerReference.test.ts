import { assert, describe, it } from "@effect/vitest";
import {
  type ChannelConversationId,
  ChannelGatewayError,
  type ChannelInputId,
  type ChannelOutboundMessage,
  type ChannelQuestionId,
  ChannelReceptionId,
  type ChannelTaskId,
  CommandId,
  EnvironmentId,
  ThreadId,
} from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { goatBotItemReaders } from "../../../../packages/client-runtime/src/goatBot/readers.ts";
import { buildGoatBotTimeline } from "../../../../packages/client-runtime/src/goatBot/rows.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { ANSWER_DECISION_ATTEMPTS } from "./channelDeliveryAttempts.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelReceptionService from "./ChannelReceptionService.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import * as ChannelTransport from "./ChannelTransport.ts";
import { mainBotKey } from "./channelBotLedger.ts";
import { answerVerdict } from "./channelPersonMessage.ts";
import {
  botMessages,
  botThreadId,
  environmentId,
  goatInput,
  latestCard,
  makeHarness,
  onlyTask,
  ownerId,
  rpcContext,
  scratchProjectId,
  setupBot,
} from "./testkit/ChannelHarness.ts";

/** A request whose project must be picked: the task asks its own question, with choices. */
const askedTask = Effect.gen(function* () {
  yield* setupBot;
  const gateway = yield* ChannelGateway.ChannelGateway;
  const runtime = yield* ChannelRuntime.ChannelRuntime;
  yield* gateway.ingest(goatInput("do: tidy the docs", "asked"), rpcContext);
  yield* runtime.drain;
  const records = yield* botMessages;
  const question = records.turnItems.find(
    (item) => item.type === "assistant_message" && item.channel?.kind === "question",
  );
  const channel = question?.type === "assistant_message" ? question.channel : undefined;
  const task = yield* onlyTask;
  return {
    gateway,
    runtime,
    task,
    questionId: channel?.questionId as ChannelQuestionId,
    options: channel?.options ?? [],
    questionKind: channel?.questionKind,
  };
});

const personMessage = (key: string) =>
  Effect.map(botMessages, (records) =>
    records.turnItems.find(
      (item) => item.type === "user_message" && item.channel?.clientMessageId === key,
    ),
  );

/** The person's message as stored now: its verdict, task and read time. */
const stored = (key: string) =>
  Effect.map(personMessage(key), (item) => {
    const channel = item?.type === "user_message" ? item.channel : undefined;
    return {
      answersQuestionId: channel?.answersQuestionId,
      taskId: channel?.taskId,
      read: channel?.readAt !== undefined,
    };
  });

const answer = (
  text: string,
  key: string,
  taskId: ChannelTaskId,
  questionId: ChannelQuestionId,
) => ({
  ...goatInput(text, key),
  intent: "answer" as const,
  taskId,
  questionId,
});

describe("which person message answered a task's question", () => {
  it.effect("a card pick is claimed on the person's message and recorded on the task card", () => {
    const harness = makeHarness({ projects: 2 });
    return Effect.gen(function* () {
      const { gateway, runtime, task, questionId, options, questionKind } = yield* askedTask;
      assert.strictEqual(questionKind, "task");
      assert.isAbove(options.length, 0);
      const sent = yield* gateway.ingest(
        answer(options[0]!, "pick", task.taskId, questionId),
        rpcContext,
      );
      yield* runtime.drain;
      const mine = yield* personMessage("pick");
      assert.strictEqual(
        mine?.type === "user_message" ? mine.channel?.answersQuestionId : undefined,
        questionId,
      );
      assert.deepStrictEqual((yield* latestCard)?.answeredQuestions, [
        { questionId, inputId: sent.inputId },
      ]);
      // A second answer to the closed question is refused and recorded nowhere.
      yield* gateway.ingest(answer(options[0]!, "again", task.taskId, questionId), rpcContext);
      yield* runtime.drain;
      assert.deepStrictEqual((yield* latestCard)?.answeredQuestions, [
        { questionId, inputId: sent.inputId },
      ]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("a choice typed as a plain message is recorded too, without a claim", () => {
    const harness = makeHarness({ projects: 2 });
    return Effect.gen(function* () {
      const { gateway, runtime, questionId, options } = yield* askedTask;
      const sent = yield* gateway.ingest(goatInput(options[0]!, "typed"), rpcContext);
      yield* runtime.drain;
      const mine = yield* personMessage("typed");
      assert.isUndefined(mine?.type === "user_message" ? mine.channel?.answersQuestionId : "none");
      assert.deepStrictEqual((yield* latestCard)?.answeredQuestions, [
        { questionId, inputId: sent.inputId },
      ]);
    }).pipe(Effect.provide(harness.layer));
  });
});

describe("what the server decided about an answer sent from a card", () => {
  it.effect("takes it only for its own task, owner, conversation and an answer it accepts", () => {
    const harness = makeHarness({ projects: 2 });
    return Effect.gen(function* () {
      const { task, questionId, options } = yield* askedTask;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const stored = yield* ledger.getTask(task.taskId);
      const requester = (yield* ledger.getInput(task.originInputId))?.requester;
      const message = {
        intent: "answer" as const,
        taskId: task.taskId,
        questionId,
        connectionId: "goat",
        text: options[0]!,
      };
      const verdict = (overrides: Partial<Parameters<typeof answerVerdict>[0]> = {}) =>
        answerVerdict({
          message,
          requester,
          conversationId: task.conversationId,
          task: stored,
          ...overrides,
        });
      assert.deepStrictEqual(verdict(), { answersQuestionId: questionId });
      // Refused: another task's question, another owner, another conversation, a skill
      // proposal answered with something it does not take.
      for (const refused of [
        verdict({ message: { ...message, questionId: "other" as ChannelQuestionId } }),
        verdict({ requester: { ...requester!, ownerId: "environment:stranger" } }),
        verdict({ conversationId: "conversation:elsewhere" }),
        verdict({
          message: { ...message, text: "maybe" },
          task: stored && {
            ...stored,
            task: {
              ...stored.task,
              skillProposal: {} as NonNullable<(typeof stored)["task"]["skillProposal"]>,
            },
          },
        }),
      ])
        assert.deepStrictEqual(refused, { answersQuestionId: null });
      // An ordinary message is no answer at all.
      assert.deepStrictEqual(verdict({ message: { ...message, intent: "message" } }), {});
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect.each([
    { label: "a pick", typed: false },
    { label: "typed words", typed: true },
  ])(
    "records $label sent to a question closed elsewhere as refused, on both revisions",
    ({ typed }) => {
      const harness = makeHarness({ projects: 2 });
      return Effect.gen(function* () {
        const { gateway, runtime, task, questionId, options } = yield* askedTask;
        yield* gateway.ingest(answer(options[0]!, "first", task.taskId, questionId), rpcContext);
        yield* runtime.drain;
        const text = typed ? "Use the docs repo" : options[0]!;
        const late = yield* gateway.ingest(
          answer(text, "late", task.taskId, questionId),
          rpcContext,
        );
        const accepted = yield* stored("late");
        assert.deepStrictEqual(accepted, {
          answersQuestionId: null,
          taskId: task.taskId,
          read: false,
        });
        yield* runtime.drain;
        assert.deepStrictEqual(yield* stored("late"), { ...accepted, read: true });
        // The refusal answers that message.
        const records = yield* botMessages;
        assert.isTrue(
          records.turnItems.some(
            (item) =>
              item.type === "assistant_message" && item.channel?.inReplyToInputId === late.inputId,
          ),
        );
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "replaces what acceptance expected with what reception decided: of two picks sent while the question was open, only the one taken keeps it",
    () => {
      const harness = makeHarness({ projects: 2 });
      return Effect.gen(function* () {
        const { gateway, runtime, task, questionId, options } = yield* askedTask;
        yield* gateway.ingest(answer(options[0]!, "one", task.taskId, questionId), rpcContext);
        yield* gateway.ingest(answer(options[0]!, "two", task.taskId, questionId), rpcContext);
        const expected = { answersQuestionId: questionId, taskId: task.taskId, read: false };
        assert.deepStrictEqual(yield* stored("one"), expected);
        assert.deepStrictEqual(yield* stored("two"), expected);
        yield* runtime.drain;
        // "one" closed the question before "two" was read, so reception refused "two".
        assert.deepStrictEqual(yield* stored("one"), { ...expected, read: true });
        assert.deepStrictEqual(yield* stored("two"), {
          ...expected,
          answersQuestionId: null,
          read: true,
        });
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "the chat built from what the server stored folds the taken pick into the question and shows the refused one as a plain message (#2977)",
    () => {
      const harness = makeHarness({ projects: 2 });
      return Effect.gen(function* () {
        const { gateway, runtime, task, questionId, options } = yield* askedTask;
        yield* gateway.ingest(answer(options[0]!, "one", task.taskId, questionId), rpcContext);
        yield* gateway.ingest(answer(options[0]!, "two", task.taskId, questionId), rpcContext);
        yield* runtime.drain;
        const records = yield* botMessages;
        const rows = buildGoatBotTimeline({
          visibleTurnItems: records.turnItems.map((item, position) => ({
            position,
            visibility: "local" as const,
            sourceThreadId: botThreadId,
            sourceItemId: item.id,
            item,
          })),
          pendingInputs: [],
          readers: goatBotItemReaders,
          taskId: null,
          answerReferences: true,
        });
        const asked = records.turnItems.find(
          (item) => item.type === "assistant_message" && item.channel?.questionId === questionId,
        );
        const one = yield* personMessage("one");
        const two = yield* personMessage("two");
        const question = rows.find((row) => row.id === asked?.id);
        assert.strictEqual(question?.kind === "bot" ? question.answer : undefined, options[0]);
        assert.strictEqual(question?.kind === "bot" ? question.answerIndex : undefined, 0);
        const people = rows.filter((row) => row.kind === "user").map((row) => row.id);
        assert.notInclude(people, one?.id);
        assert.include(people, two?.id);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "what the server stored for a taken and a refused answer folds in the task's own view by reference (#2977)",
    () => {
      const harness = makeHarness({ projects: 2 });
      return Effect.gen(function* () {
        const { gateway, runtime, task, questionId, options } = yield* askedTask;
        yield* gateway.ingest(answer(options[0]!, "one", task.taskId, questionId), rpcContext);
        yield* gateway.ingest(answer(options[0]!, "two", task.taskId, questionId), rpcContext);
        yield* runtime.drain;
        const records = yield* botMessages;
        const rows = buildGoatBotTimeline({
          visibleTurnItems: records.turnItems.map((item, position) => ({
            position,
            visibility: "local" as const,
            sourceThreadId: botThreadId,
            sourceItemId: item.id,
            item,
          })),
          pendingInputs: [],
          readers: goatBotItemReaders,
          taskId: task.taskId,
          knownTaskIds: [task.taskId],
          conversationOnly: true,
          answerReferences: true,
        });
        const asked = records.turnItems.find(
          (item) => item.type === "assistant_message" && item.channel?.questionId === questionId,
        );
        const one = yield* personMessage("one");
        const two = yield* personMessage("two");
        const question = rows.find((row) => row.id === asked?.id);
        assert.strictEqual(question?.kind === "bot" ? question.answer : undefined, options[0]);
        assert.strictEqual(question?.kind === "bot" ? question.answerIndex : undefined, 0);
        const people = rows.filter((row) => row.kind === "user").map((row) => row.id);
        assert.notInclude(people, one?.id);
        assert.include(people, two?.id);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "an answer reception never read (home moved, or past its deadline) ends refused and unread",
    () => {
      const harness = makeHarness({ projects: 2 });
      return Effect.gen(function* () {
        const { gateway, runtime, task, questionId, options } = yield* askedTask;
        const settings = yield* ServerSettings.ServerSettingsService;
        const expected = { answersQuestionId: questionId, taskId: task.taskId, read: false };

        yield* gateway.ingest(answer(options[0]!, "late", task.taskId, questionId), rpcContext);
        assert.deepStrictEqual(yield* stored("late"), expected);
        yield* TestClock.adjust("56 seconds");
        assert.strictEqual(yield* runtime.expireOverdue, 1);
        yield* runtime.drain;
        assert.deepStrictEqual(yield* stored("late"), { ...expected, answersQuestionId: null });

        yield* gateway.ingest(answer(options[0]!, "moved", task.taskId, questionId), rpcContext);
        assert.deepStrictEqual(yield* stored("moved"), expected);
        yield* settings.updateSettings({
          goatBotHome: {
            environmentId: EnvironmentId.make("environment:other-home"),
            claimedAt: 1,
            claimId: "home-1",
          },
        });
        yield* runtime.drain;
        assert.deepStrictEqual(yield* stored("moved"), { ...expected, answersQuestionId: null });
      }).pipe(Effect.provide(harness.layer));
    },
  );
});

/** The committed decision's own delivery row for an input, if reception wrote one. */
const answerRow = (inputId: ChannelInputId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly state: string; readonly message_json: string }>`
      SELECT state, message_json FROM channel_outbox WHERE cause_key = ${"answer:" + inputId}`;
    return rows.map((row) => ({
      state: row.state,
      personAnswer: (JSON.parse(row.message_json) as { personAnswer?: unknown }).personAnswer,
    }));
  });

/** The decision row's state and how many times it was handed to its transport. */
const answerAttempts = (inputId: ChannelInputId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{ readonly state: string; readonly attempts: number }>`
      SELECT state, attempts FROM channel_outbox WHERE cause_key = ${"answer:" + inputId}`;
    return row;
  });

/**
 * The GOAT transport with its decision writes failing while `failing` holds; `writes` lists the
 * input each decision write was for.
 */
const decisionWrites = Effect.gen(function* () {
  const registry = yield* ChannelTransport.ChannelTransportRegistry;
  const goat = Option.getOrThrow(yield* registry.resolve("goat"));
  const control = { failing: true, writes: [] as Array<string | undefined> };
  yield* registry.register({
    kind: "goat",
    send: (message: ChannelOutboundMessage) => {
      if (message.personAnswer === undefined) return goat.send(message);
      control.writes.push(message.inReplyToInputId);
      return control.failing
        ? Effect.fail(new ChannelGatewayError({ reason: "persistence_failed" }))
        : goat.send(message);
    },
  });
  return control;
});

/** Two picks sent while the question was open: the first is taken, the second refused. */
const twoPicks = Effect.gen(function* () {
  const { gateway, runtime, task, questionId, options } = yield* askedTask;
  const one = yield* gateway.ingest(
    answer(options[0]!, "one", task.taskId, questionId),
    rpcContext,
  );
  const two = yield* gateway.ingest(
    answer(options[0]!, "two", task.taskId, questionId),
    rpcContext,
  );
  return { runtime, questionId, one, two };
});

/** Passes far enough apart (a decision waits at most ten minutes) that a failing write is tried once per pass. */
const failPasses = (runtime: ChannelRuntime.ChannelRuntime["Service"], passes: number) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < passes; attempt += 1) {
      yield* runtime.drain;
      yield* TestClock.adjust("10 minutes");
    }
  });

describe("delivering reception's decision about an answer", () => {
  it.effect(
    "a decision write interrupted mid-send, then recovered after its receipt's deadline, is recorded once",
    () => {
      const harness = makeHarness({ projects: 2 });
      return Effect.gen(function* () {
        const { gateway, runtime, task, questionId, options } = yield* askedTask;
        const held = yield* heldDecisionWrites;
        const sent = yield* gateway.ingest(
          answer(options[0]!, "one", task.taskId, questionId),
          rpcContext,
        );
        // The worker claims the decision write and is stopped while it is being written.
        const pass = yield* runtime.drain.pipe(Effect.forkChild);
        yield* Deferred.await(held.reached);
        yield* Fiber.interrupt(pass);
        assert.deepStrictEqual(yield* answerRow(sent.inputId), [
          { state: "delivering", personAnswer: { answersQuestionId: questionId } },
        ]);
        held.holding = false;
        yield* TestClock.adjust("61 seconds");
        yield* runtime.recover;
        assert.deepStrictEqual(yield* answerRow(sent.inputId), [
          { state: "pending", personAnswer: { answersQuestionId: questionId } },
        ]);
        yield* runtime.drain;
        assert.deepStrictEqual(yield* answerRow(sent.inputId), [
          { state: "delivered", personAnswer: { answersQuestionId: questionId } },
        ]);
        assert.strictEqual(
          (yield* botMessages).turnItems.filter(
            (item) => item.type === "user_message" && item.channel?.clientMessageId === "one",
          ).length,
          1,
        );
        assert.strictEqual((yield* stored("one")).answersQuestionId, questionId);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "a refusal whose write keeps failing stays on the normal retry path past ten attempts, and is written once it succeeds (#2977)",
    () => {
      const harness = makeHarness({ projects: 2 });
      return Effect.gen(function* () {
        const { runtime, questionId, two } = yield* twoPicks;
        const writes = yield* decisionWrites;
        yield* failPasses(runtime, 10);
        // Ten failed tries would fail any other delivery; a decision is still waiting for its next.
        assert.deepStrictEqual(yield* answerAttempts(two.inputId), {
          state: "pending",
          attempts: 10,
        });
        // Acceptance expected the pick to answer the question; nothing has corrected it yet.
        assert.strictEqual((yield* stored("two")).answersQuestionId, questionId);
        writes.failing = false;
        yield* runtime.drain;
        assert.strictEqual((yield* answerAttempts(two.inputId))?.state, "delivered");
        assert.strictEqual((yield* stored("two")).answersQuestionId, null);
        assert.strictEqual((yield* stored("one")).answersQuestionId, questionId);
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("a decision write that keeps failing fails after its larger number of attempts", () => {
    const harness = makeHarness({ projects: 2 });
    return Effect.gen(function* () {
      const { runtime, two } = yield* twoPicks;
      const writes = yield* decisionWrites;
      yield* failPasses(runtime, ANSWER_DECISION_ATTEMPTS + 2);
      assert.strictEqual(
        writes.writes.filter((inputId) => inputId === two.inputId).length,
        ANSWER_DECISION_ATTEMPTS,
      );
      assert.deepStrictEqual(yield* answerAttempts(two.inputId), {
        state: "failed",
        attempts: ANSWER_DECISION_ATTEMPTS,
      });
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect.each([
    { label: "its thread was replaced", gone: false },
    { label: "it is gone", gone: true },
  ])(
    "writes nothing when the bot the answer was sent to $label, and closes the delivery",
    ({ gone }) => {
      const harness = makeHarness({ projects: 2 });
      return Effect.gen(function* () {
        const { gateway, runtime, task, questionId, options } = yield* askedTask;
        const reception = yield* ChannelReceptionService.ChannelReceptionService;
        const ledger = yield* ChannelLedger.ChannelLedger;
        const sql = yield* SqlClient.SqlClient;
        const one = yield* gateway.ingest(
          answer(options[0]!, "one", task.taskId, questionId),
          rpcContext,
        );
        const two = yield* gateway.ingest(
          answer(options[0]!, "two", task.taskId, questionId),
          rpcContext,
        );
        assert.isTrue(yield* runtime.claimForWork);
        yield* reception.receive(one.inputId, runtime.ownerToken);
        yield* reception.receive(two.inputId, runtime.ownerToken);
        assert.deepStrictEqual(yield* answerRow(two.inputId), [
          { state: "pending", personAnswer: { answersQuestionId: null } },
        ]);
        const nextThreadId = ThreadId.make("thread:goat-bot-next");
        if (gone) {
          yield* sql`DELETE FROM channel_runtime_state WHERE key = ${mainBotKey(ownerId)}`;
          // The replies can no longer be recorded anywhere; they settle at their deadline.
          yield* TestClock.adjust("61 seconds");
        } else {
          yield* (yield* Orchestrator.OrchestratorV2).dispatch({
            type: "thread.create",
            commandId: CommandId.make("create-goat-bot-next"),
            threadId: nextThreadId,
            projectId: scratchProjectId,
            title: "GOAT bot",
            modelSelection: { instanceId: "codex" as never, model: "gpt-6.1-sol" },
            runtimeMode: "approval-required",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdBy: "system",
            creationSource: "server",
          });
          yield* ledger.replaceBot({
            ownerId,
            previousThreadId: botThreadId,
            bot: { environmentId, projectId: scratchProjectId, threadId: nextThreadId },
            now: "2026-10-12T00:00:01.000Z",
          });
        }
        yield* runtime.drain;
        assert.deepStrictEqual(yield* answerRow(two.inputId), [
          { state: "delivered", personAnswer: { answersQuestionId: null } },
        ]);
        // The old thread keeps what acceptance expected; the new one never gets the message.
        assert.strictEqual((yield* stored("two")).answersQuestionId, questionId);
        if (!gone) {
          const threads = yield* ThreadManagement.ThreadManagementService;
          const next = yield* threads.getThreadRecords(nextThreadId, ["turnItems"]);
          assert.isFalse(next.turnItems.some((item) => item.type === "user_message"));
        }
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "only the pass that settles an answer commits its decision, and with no answered question it is a refusal",
    () => {
      const harness = makeHarness({ projects: 2 });
      return Effect.gen(function* () {
        const { gateway, runtime, task, questionId, options } = yield* askedTask;
        const ledger = yield* ChannelLedger.ChannelLedger;
        const sent = yield* gateway.ingest(
          answer(options[0]!, "one", task.taskId, questionId),
          rpcContext,
        );
        assert.isTrue(yield* runtime.claimForWork);
        const owner = runtime.ownerToken;
        const first = ChannelReceptionId.make("channel-reception:first");
        const second = ChannelReceptionId.make("channel-reception:second");
        const now = "2026-10-12T00:00:01.000Z";
        for (const receptionId of [first, second])
          yield* ledger.beginReception({ owner, inputId: sent.inputId, receptionId, readAt: now });
        const complete = (receptionId: ChannelReceptionId) =>
          ledger.completeReception({
            owner,
            inputId: sent.inputId,
            receptionId,
            replyText: "Noted.",
            decision: { replyText: "Noted.", action: { type: "report_only" } },
            deliveries: [],
            now,
          });
        assert.isFalse(yield* complete(first));
        assert.deepStrictEqual(yield* answerRow(sent.inputId), []);
        assert.isTrue(yield* complete(second));
        assert.deepStrictEqual(yield* answerRow(sent.inputId), [
          { state: "pending", personAnswer: { answersQuestionId: null } },
        ]);
      }).pipe(Effect.provide(harness.layer));
    },
  );
});

describe("recording a person's message more than once", () => {
  const record = (revision: string, meta: object, answerDecided?: true) =>
    Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
      orchestrator.dispatch({
        type: "channel.timeline.record",
        commandId: CommandId.make("person-" + revision),
        threadId: botThreadId,
        record: {
          recordKey: "input:in-1",
          entry: {
            type: "message",
            role: "user",
            text: "Keep",
            ...(answerDecided === undefined ? {} : { answerDecided }),
            meta: {
              conversationId: "conversation-1" as ChannelConversationId,
              originKind: "goat",
              kind: "inbound",
              inputId: "in-1" as ChannelInputId,
              clientMessageId: "person",
              ...meta,
            },
          },
        },
      }),
    );
  const channel = Effect.map(personMessage("person"), (item) =>
    item?.type === "user_message" ? item.channel : undefined,
  );
  const q = "question-1" as ChannelQuestionId;

  it.effect("a decided answer outlasts any later provisional record, in either order", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      yield* record("decided", { answersQuestionId: null }, true);
      yield* record("accepted", { answersQuestionId: q });
      yield* record("read", { readAt: "2026-10-12T00:00:02.000Z" });
      assert.strictEqual((yield* channel)?.answersQuestionId, null);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "a decision replaces what acceptance expected, and a later record keeps the read time",
    () => {
      const harness = makeHarness();
      return Effect.gen(function* () {
        yield* setupBot;
        yield* record("accepted", { answersQuestionId: null });
        yield* record("read", { readAt: "2026-10-12T00:00:02.000Z" });
        yield* record("accepted-again", { answersQuestionId: null });
        assert.strictEqual((yield* channel)?.readAt, "2026-10-12T00:00:02.000Z");
        yield* record("decided", { answersQuestionId: q }, true);
        assert.deepInclude(yield* channel, {
          answersQuestionId: q,
          readAt: "2026-10-12T00:00:02.000Z",
        });
      }).pipe(Effect.provide(harness.layer));
    },
  );
});

/** The GOAT transport with its decision writes held forever while holding; reached settles at the first. */
const heldDecisionWrites = Effect.gen(function* () {
  const registry = yield* ChannelTransport.ChannelTransportRegistry;
  const goat = Option.getOrThrow(yield* registry.resolve("goat"));
  const reached = yield* Deferred.make<void>();
  const control = { holding: true, reached };
  yield* registry.register({
    kind: "goat",
    send: (message: ChannelOutboundMessage) =>
      message.personAnswer === undefined || !control.holding
        ? goat.send(message)
        : Deferred.succeed(reached, undefined).pipe(Effect.andThen(Effect.never)),
  });
  return control;
});
