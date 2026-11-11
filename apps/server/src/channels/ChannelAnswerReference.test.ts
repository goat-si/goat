import { assert, describe, it } from "@effect/vitest";
import type { ChannelQuestionId, ChannelTaskId } from "@goat/contracts";
import * as Effect from "effect/Effect";

import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import { verifiedAnswerClaim } from "./channelPersonMessage.ts";
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

describe("the reference the server stands behind", () => {
  it.effect(
    "names a question only for its own task, owner and conversation while it is open",
    () => {
      const harness = makeHarness({ projects: 2 });
      return Effect.gen(function* () {
        const { gateway, runtime, task, questionId, options } = yield* askedTask;
        const ledger = yield* ChannelLedger.ChannelLedger;
        const stored = yield* ledger.getTask(task.taskId);
        const asked = yield* ledger.getInput(task.originInputId);
        const requester = asked?.requester;
        const message = {
          intent: "answer" as const,
          taskId: task.taskId,
          questionId,
          connectionId: "goat",
        };
        const claim = (overrides: Partial<Parameters<typeof verifiedAnswerClaim>[0]> = {}) =>
          verifiedAnswerClaim({
            message,
            requester,
            conversationId: task.conversationId,
            task: stored,
            ...overrides,
          }).answersQuestionId;
        assert.strictEqual(claim(), questionId);
        // Another task's question, another owner, another conversation: nothing to stand behind.
        assert.isUndefined(
          claim({ message: { ...message, questionId: "other-question" as ChannelQuestionId } }),
        );
        assert.isUndefined(
          claim({ requester: { ...requester!, ownerId: "environment:stranger" } }),
        );
        assert.isUndefined(claim({ conversationId: "conversation:elsewhere" }));
        // Once the question is answered it is closed, and a later answer to it names nothing.
        yield* gateway.ingest(answer(options[0]!, "first", task.taskId, questionId), rpcContext);
        yield* runtime.drain;
        const again = yield* gateway.ingest(
          answer(options[0]!, "late", task.taskId, questionId),
          rpcContext,
        );
        yield* runtime.drain;
        const late = yield* personMessage("late");
        assert.isUndefined(
          late?.type === "user_message" ? late.channel?.answersQuestionId : "missing",
        );
        assert.isDefined(again.inputId);
      }).pipe(Effect.provide(harness.layer));
    },
  );
});
