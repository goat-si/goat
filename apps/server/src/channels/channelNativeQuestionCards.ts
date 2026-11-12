/**
 * Cards for a native question a coding thread asked. In the GOAT app, one question with options
 * is buttons. Slack, iMessage, and any other shape get one untagged line pointing at the work
 * thread. A question on another machine stays on the chip.
 *
 * @module channelNativeQuestionCards
 */
import {
  ChannelQuestionId,
  CommandId,
  type ChannelInputId,
  type ChannelRequester,
  type ChannelTask,
  type ChannelTaskApprovalRef,
  type ChannelTaskNeedsYou,
  type OrchestrationV2UserInputQuestion,
  type ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { mayDirect } from "./ChannelGateway.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import { CHANNEL_COPY } from "./channelCopy.ts";
import { replyDelivery } from "./channelReplyDelivery.ts";
import { mentionFor } from "./channelTaskThreadRefusal.ts";

const READ_TIMEOUT_MS = 5_000;

export interface NativeQuestionChoice {
  readonly type: "native-question";
  readonly taskId: ChannelTask["taskId"];
  readonly threadId: ThreadId;
  readonly requestId: ChannelTaskApprovalRef["requestId"];
  readonly questionId: string;
  readonly label: string;
}

const singleChoice = (
  questions: ReadonlyArray<OrchestrationV2UserInputQuestion>,
): OrchestrationV2UserInputQuestion | undefined => {
  const [question, ...rest] = questions;
  if (
    question === undefined ||
    rest.length > 0 ||
    question.multiSelect === true ||
    question.options.length === 0
  ) {
    return undefined;
  }
  return question;
};

const recentRecords = Effect.fn("channel.nativeQuestionRecords")(
  function* (threads: ThreadManagement.ThreadManagementService["Service"], threadId: ThreadId) {
    const { runs } = yield* threads.getThreadRecords(threadId, ["runs"]);
    return yield* threads.getThreadRecords(threadId, ["runtimeRequests", "turnItems"], {
      turnItemRunIds: runs.slice(-2).map((run) => run.id),
    });
  },
  Effect.timeoutOption(READ_TIMEOUT_MS),
  Effect.map(Option.getOrUndefined),
  Effect.orElseSucceed(() => undefined),
);

export const approvalRequestDetail = Effect.fn("channel.approvalRequestDetail")(function* (
  approval: ChannelTaskApprovalRef,
  threads: ThreadManagement.ThreadManagementService["Service"],
) {
  // Another machine's request: a local thread with the same ids is not its record.
  if (approval.host !== undefined) return { kind: undefined, prompt: undefined };
  const records = yield* recentRecords(threads, approval.threadId);
  const item = records?.turnItems.find(
    (entry) => entry.type === "approval_request" && entry.requestId === approval.requestId,
  );
  return {
    kind: records?.runtimeRequests.find((request) => request.id === approval.requestId)?.kind,
    prompt: item?.type === "approval_request" ? item.prompt : undefined,
  };
});

/** The words of a native question, as its coding thread asked it. */
export const nativeQuestionText = Effect.fn("channel.nativeQuestionText")(function* (
  ref: ChannelTaskApprovalRef,
  threads: ThreadManagement.ThreadManagementService["Service"],
) {
  const records = yield* recentRecords(threads, ref.threadId);
  const item = records?.turnItems.find(
    (entry) => entry.type === "user_input_request" && entry.requestId === ref.requestId,
  );
  return item?.type === "user_input_request" ? item.questions[0]?.question : undefined;
});

const choiceFor = Effect.fn("channel.nativeQuestionChoiceFor")(function* (
  ref: ChannelTaskApprovalRef,
  threads: ThreadManagement.ThreadManagementService["Service"],
) {
  const records = yield* recentRecords(threads, ref.threadId);
  const item = records?.turnItems.find(
    (entry) => entry.type === "user_input_request" && entry.requestId === ref.requestId,
  );
  return item?.type === "user_input_request" ? singleChoice(item.questions) : undefined;
});

export const nativeQuestionDeliveries = Effect.fn("channel.nativeQuestionCards")(function* (
  task: ChannelTask,
  listed: ReadonlyArray<ChannelTaskNeedsYou>,
  threads: ThreadManagement.ThreadManagementService["Service"],
) {
  const deliveries: Array<ChannelLedger.ChannelOutboxInsert> = [];
  for (const need of listed) {
    const question = need.question;
    if (question === undefined || question.host !== undefined) continue;
    const card = yield* choiceFor(question, threads);
    const mentionActorId = mentionFor(task.originAddress, task.requester.externalActorId);
    if (card === undefined || task.originAddress.kind !== "goat") {
      deliveries.push(
        replyDelivery({
          causeKey: "native-question-line:" + question.requestId,
          destination: task.originAddress,
          kind: "receipt",
          text:
            task.title +
            " is asking something in its coding thread. Open the work thread to answer.",
          replyTo: task.originInputId,
          mentionActorId,
        }),
      );
      continue;
    }
    deliveries.push(
      replyDelivery({
        causeKey: "native-question:" + question.requestId,
        destination: task.originAddress,
        kind: "question",
        text: task.kind === "turn" ? card.question : task.title + ": " + card.question,
        task,
        mentionActorId,
        options: card.options.map((option) => option.label),
        questionId: ChannelQuestionId.make(question.requestId),
      }),
    );
  }
  return deliveries;
});

/** An option of this task's open local native-question card, if the text is exactly that option. */
export const nativeQuestionChoice = Effect.fn("channel.nativeQuestionChoice")(function* (
  task: ChannelTask,
  text: string,
  threads: ThreadManagement.ThreadManagementService["Service"],
) {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  for (const need of task.observed?.needsYou ?? []) {
    const question = need.question;
    if (question === undefined || question.host !== undefined) continue;
    const card = yield* choiceFor(question, threads);
    const matched = card?.options.find((option) => option.label === trimmed);
    if (card === undefined || matched === undefined) continue;
    const choice: NativeQuestionChoice = {
      type: "native-question",
      taskId: task.taskId,
      threadId: question.threadId,
      requestId: question.requestId,
      questionId: card.id,
      label: matched.label,
    };
    return choice;
  }
  return undefined;
});

export const answerNativeQuestion = Effect.fn("channel.answerNativeQuestion")(function* (
  choice: NativeQuestionChoice,
  answerer: ChannelRequester | undefined,
  message: {
    readonly connectionId: string | undefined;
    readonly kind: ChannelRequester["originKind"];
  },
  inputId: ChannelInputId,
  threads: ThreadManagement.ThreadManagementService["Service"],
  ledger: ChannelLedger.ChannelLedger["Service"],
) {
  const task = (yield* ledger.getTask(choice.taskId))?.task;
  if (
    task === undefined ||
    answerer === undefined ||
    !mayDirect(answerer, message.connectionId, task)
  ) {
    return { text: CHANNEL_COPY.answerNotAllowed, options: undefined, task: undefined };
  }
  const sent = yield* threads
    .dispatch({
      type: "runtime-request.respond",
      commandId: CommandId.make("channel-native-question:" + inputId),
      threadId: choice.threadId,
      requestId: choice.requestId,
      answers: { [choice.questionId]: choice.label },
      respondedBy: {
        type: "client",
        label: "GOAT Bot",
        reason: "Answered by " + answerer.displayName + " from GOAT Bot (" + message.kind + ").",
      },
    })
    .pipe(
      Effect.as(true),
      Effect.catch((cause) =>
        Effect.logWarning("GOAT Bot question not answered", { cause }).pipe(Effect.as(false)),
      ),
    );
  if (sent) {
    return {
      text: "Sent your answer to " + task.title + ".",
      options: undefined,
      task: undefined,
    };
  }
  const pending = yield* threads.getThreadRecords(choice.threadId, ["runtimeRequests"]).pipe(
    Effect.map((records) =>
      records.runtimeRequests.some(
        (request) => request.id === choice.requestId && request.status === "pending",
      ),
    ),
    Effect.orElseSucceed(() => true),
  );
  return {
    text: pending
      ? "I couldn't pass that answer on. Open the work thread to answer it there."
      : CHANNEL_COPY.questionAlreadyAnswered,
    options: undefined,
    task: undefined,
  };
});
