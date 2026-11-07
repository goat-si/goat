import { assert, it } from "@effect/vitest";
import { ChannelConversationId, ChannelQuestionId, ChannelTaskId } from "@goat/contracts";
import * as Effect from "effect/Effect";

import type * as ChannelLedger from "./ChannelLedger.ts";
import { makeInboundChoices } from "./channelInboundChoice.ts";

const conversationId = ChannelConversationId.make("conv-1");
const taskId = ChannelTaskId.make("task-1");
const question = (id: string) => ({
  questionId: ChannelQuestionId.make(id),
  text: "Save this as a skill?",
  askedAt: "2026-11-08T00:00:00.000Z",
  options: ["Save", "Not now"],
});

const storedTask = (overrides: Record<string, unknown> = {}) =>
  ({
    ownerId: "owner",
    task: {
      taskId,
      conversationId,
      status: "waiting_input",
      openQuestions: [question("q-1")],
      ...overrides,
    },
  }) as unknown as ChannelLedger.ChannelStoredTask;

const input = (overrides: Record<string, unknown> = {}) =>
  ({
    ownerId: "owner",
    snapshot: { conversationId },
    message: { intent: "message", kind: "goat", text: "Save", taskId, ...overrides },
  }) as unknown as ChannelLedger.ChannelStoredInput;

const choiceFor = (
  stored: ChannelLedger.ChannelStoredInput,
  task: ChannelLedger.ChannelStoredTask,
) =>
  makeInboundChoices({
    getTask: () => Effect.succeed(task),
  } as unknown as ChannelLedger.ChannelLedger["Service"]).taskViewChoice(stored);

it.effect(
  "a choice pressed in a workerless task's view answers that task's one matching question",
  () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* choiceFor(input(), storedTask()), {
        type: "question",
        taskId,
        questionId: ChannelQuestionId.make("q-1"),
        answer: "Save",
      });
      // Ambiguous, someone else's, elsewhere, forwarded to a worker, or not from the GOAT app: none.
      const none = [
        choiceFor(input(), storedTask({ openQuestions: [question("q-1"), question("q-2")] })),
        choiceFor(input(), { ...storedTask(), ownerId: "stranger" }),
        choiceFor(input(), storedTask({ conversationId: ChannelConversationId.make("conv-2") })),
        choiceFor(input(), storedTask({ worker: { threadId: "worker" } })),
        choiceFor(input(), storedTask({ status: "running" })),
        choiceFor(input({ kind: "mcp" }), storedTask()),
        choiceFor(input({ text: "Maybe later" }), storedTask()),
      ];
      for (const choice of none) assert.isUndefined(yield* choice);
    }),
);
