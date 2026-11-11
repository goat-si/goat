import { assert, describe, it } from "@effect/vitest";
import type { ChannelQuestionId, ChannelTaskId } from "@goat/contracts";
import * as Effect from "effect/Effect";

import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import { answerVerdict } from "./channelPersonMessage.ts";
import {
  botMessages,
  goatInput,
  latestCard,
  makeHarness,
  onlyTask,
  rpcContext,
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
    "keeps on the read revision what acceptance decided, even after the question closed",
    () => {
      const harness = makeHarness({ projects: 2 });
      return Effect.gen(function* () {
        const { gateway, runtime, task, questionId, options } = yield* askedTask;
        yield* gateway.ingest(answer(options[0]!, "one", task.taskId, questionId), rpcContext);
        yield* gateway.ingest(answer(options[0]!, "two", task.taskId, questionId), rpcContext);
        const accepted = yield* stored("two");
        assert.deepStrictEqual(accepted, {
          answersQuestionId: questionId,
          taskId: task.taskId,
          read: false,
        });
        yield* runtime.drain;
        // "one" closed the question before "two" was read; the read copy still says what was decided.
        assert.deepStrictEqual(yield* stored("two"), { ...accepted, read: true });
      }).pipe(Effect.provide(harness.layer));
    },
  );
});
