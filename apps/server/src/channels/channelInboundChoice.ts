import type { ChannelInboundMessage, ChannelConversationId, ChannelTask } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as ChannelLedger from "./ChannelLedger.ts";
import type * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { openApprovalCards, parseApprovalReply } from "./channelApprovalCards.ts";
import { pendingApprovals } from "./channelApprovalReplies.ts";
import { nativeQuestionChoice, type NativeQuestionChoice } from "./channelNativeQuestionCards.ts";
import {
  choiceAt,
  isNumericReply,
  latestDeliveredChoices,
  parseNumberedReply,
  singleQuestionChoice,
  type DeliveredChoices,
} from "./channelDecisionChoices.ts";

export const makeInboundChoices = (
  ledger: ChannelLedger.ChannelLedger["Service"],
  threads?: ThreadManagement.ThreadManagementService["Service"],
) => {
  /**
   * What a Slack or iMessage reply of "2" does. While any approval is open it answers nothing:
   * cards once listed numbers in either order, so a number typed for one must not land on a
   * question or another card. Otherwise it picks from the latest open question, from the recent
   * tasks plus any older task still needing a person.
   */
  const numberedChoice = Effect.fn("channel.numberedChoice")(function* (
    conversationId: ChannelConversationId,
    tasks: ReadonlyArray<ChannelTask>,
    number: number | undefined,
  ) {
    const needing = yield* ledger.listConversationNeedsYou(conversationId);
    const listed = openApprovalCards(needing);
    const open = threads === undefined ? listed : yield* pendingApprovals(listed, threads);
    if (open.length > 0) return { type: "approval-number" as const, open };
    const seen = new Set(tasks.map((task) => task.taskId));
    const questions = [...tasks, ...needing.filter((task) => !seen.has(task.taskId))].flatMap(
      (task) =>
        task.openQuestions.flatMap((question): ReadonlyArray<DeliveredChoices> =>
          question.options === undefined || question.options.length === 0
            ? []
            : [
                {
                  at: question.askedAt,
                  options: question.options,
                  target: {
                    type: "question",
                    taskId: task.taskId,
                    questionId: question.questionId,
                  },
                },
              ],
        ),
    );
    const choices = latestDeliveredChoices(questions);
    const label =
      choices === undefined || number === undefined ? undefined : choiceAt(choices, number);
    return choices === undefined || label === undefined
      ? undefined
      : {
          type: "question" as const,
          taskId: choices.target.taskId,
          questionId: choices.target.questionId,
          answer: label,
        };
  });

  /** A native-question button exists only in the GOAT app. Slack and iMessage cannot answer one. */
  const answersNativeQuestion = (kind: ChannelInboundMessage["kind"]) => kind === "goat";

  /**
   * A choice answered before the model runs: a number on Slack or iMessage (see numberedChoice),
   * or a label equal to the only open question's option. An approval word is left for the
   * approval parser, which already checks who may answer.
   */
  const inboundChoice = Effect.fn("channel.inboundChoice")(function* (
    message: ChannelInboundMessage,
    conversationId: ChannelConversationId,
    tasks: ReadonlyArray<ChannelTask>,
  ) {
    if (message.intent !== "message" || message.kind === "mcp") return undefined;
    if ((message.kind === "slack" || message.kind === "imessage") && isNumericReply(message.text)) {
      const number = parseNumberedReply(message.text);
      const picked = yield* numberedChoice(conversationId, tasks, number);
      if (picked !== undefined) return picked;
    }
    if (parseApprovalReply(message.text) !== undefined) return undefined;
    // The tasks already read for this pass. A label is not worth a second scan of older work;
    // a number still looks those up, because an older task's question stays answerable.
    const questions = tasks.flatMap((task) =>
      task.openQuestions.map((question) => ({
        taskId: task.taskId,
        questionId: question.questionId,
        options: question.options,
      })),
    );
    const matched = singleQuestionChoice(message.text, questions);
    if (matched !== undefined) return { type: "question" as const, ...matched };
    if (!answersNativeQuestion(message.kind) || threads === undefined) return undefined;
    const natives: Array<NativeQuestionChoice> = [];
    for (const task of tasks) {
      const local = (task.observed?.needsYou ?? []).some(
        (need) => need.question !== undefined && need.question.host === undefined,
      );
      if (!local) continue;
      const found = yield* nativeQuestionChoice(task, message.text, threads);
      if (found !== undefined) natives.push(found);
    }
    const [only, ...rest] = natives;
    return rest.length === 0 ? only : undefined;
  });

  /**
   * A choice pressed in a task's own view of the GOAT app, for a question nobody runs to forward
   * it to (no worker): it answers that task's one matching question. An approve or deny, typed or
   * pressed, or a native-question option matches first, including while the task is still
   * running. Who may answer is checked where the answer is recorded.
   */
  const taskViewChoice = Effect.fn("channel.taskViewChoice")(function* (
    stored: ChannelLedger.ChannelStoredInput,
  ) {
    const message = stored.message;
    if (message.intent !== "message" || message.kind !== "goat" || message.taskId === undefined)
      return undefined;
    const target = yield* ledger.getTask(message.taskId);
    if (
      target === undefined ||
      target.ownerId !== stored.ownerId ||
      target.task.conversationId !== stored.snapshot.conversationId
    )
      return undefined;
    const trimmed = message.text.trim();
    // Forwarded, an approval reply would reach an agent that can't answer it.
    if (openApprovalCards([target.task]).length > 0 && parseApprovalReply(trimmed) !== undefined) {
      return { type: "approval-label" as const, text: trimmed };
    }
    const hasNativeQuestion = (target.task.observed?.needsYou ?? []).some(
      (need) => need.question !== undefined && need.question.host === undefined,
    );
    if (hasNativeQuestion) {
      if (!answersNativeQuestion(message.kind)) return undefined;
      const native =
        threads === undefined
          ? undefined
          : yield* nativeQuestionChoice(target.task, message.text, threads);
      if (native !== undefined) return native;
    }
    if (target.task.status !== "waiting_input" || target.task.worker !== undefined) {
      return undefined;
    }
    const matched = singleQuestionChoice(
      message.text,
      target.task.openQuestions.map((question) => ({
        taskId: target.task.taskId,
        questionId: question.questionId,
        options: question.options,
      })),
    );
    return matched === undefined ? undefined : { type: "question" as const, ...matched };
  });

  const isDeterministicReply = Effect.fn("ChannelReceptionService.isDeterministicReply")(function* (
    stored: ChannelLedger.ChannelStoredInput,
  ) {
    if (parseApprovalReply(stored.message.text) !== undefined) return true;
    const tasks = yield* ledger.listConversationTasks(stored.snapshot.conversationId);
    return (
      (yield* inboundChoice(stored.message, stored.snapshot.conversationId, tasks)) !== undefined
    );
  });

  return { inboundChoice, isDeterministicReply, taskViewChoice };
};
