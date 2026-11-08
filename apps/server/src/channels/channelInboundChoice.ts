import type { ChannelInboundMessage, ChannelConversationId, ChannelTask } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as ChannelLedger from "./ChannelLedger.ts";
import type * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import {
  approvalChoiceLabels,
  openApprovalCards,
  parseApprovalReply,
} from "./channelApprovalCards.ts";
import { nativeQuestionChoice } from "./channelNativeQuestionCards.ts";
import {
  approvalCodeOrder,
  choiceAt,
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
   * The numbered list a Slack or iMessage reply of "2" refers to: the latest open approval
   * card or question in this conversation. Cards that were never sent have no code and are
   * skipped. Questions come from the recent tasks plus any older task still needing a person.
   */
  const deliveredChoices = Effect.fn("channel.deliveredChoices")(function* (
    conversationId: ChannelConversationId,
    tasks: ReadonlyArray<ChannelTask>,
  ) {
    const needing = yield* ledger.listConversationNeedsYou(conversationId);
    const seen = new Set(tasks.map((task) => task.taskId));
    const questions = [...tasks, ...needing.filter((task) => !seen.has(task.taskId))].flatMap(
      (task) =>
        task.openQuestions.flatMap((question): ReadonlyArray<DeliveredChoices> =>
          question.options === undefined || question.options.length === 0
            ? []
            : [
                {
                  at: question.askedAt,
                  tie: 0,
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
    const coded = yield* Effect.forEach(openApprovalCards(needing), (card) =>
      ledger.approvalCodeForRequest(card.approval.requestId).pipe(
        Effect.map((found): DeliveredChoices | undefined =>
          found === undefined
            ? undefined
            : {
                at: found.issuedAt,
                tie: approvalCodeOrder(found.code),
                options: approvalChoiceLabels(found.code),
                target: { type: "approval" },
              },
        ),
      ),
    );
    return latestDeliveredChoices([
      ...questions,
      ...coded.flatMap((entry) => (entry === undefined ? [] : [entry])),
    ]);
  });

  /**
   * A choice answered before the model runs. A number on Slack or iMessage selects the latest
   * open list. A label equal to the only open question's option answers that question. An
   * approval word is left for the approval parser, which already checks who may answer.
   */
  const inboundChoice = Effect.fn("channel.inboundChoice")(function* (
    message: ChannelInboundMessage,
    conversationId: ChannelConversationId,
    tasks: ReadonlyArray<ChannelTask>,
  ) {
    if (message.intent !== "message" || message.kind === "mcp") return undefined;
    if (message.kind === "slack" || message.kind === "imessage") {
      const number = parseNumberedReply(message.text);
      if (number !== undefined) {
        const choices = yield* deliveredChoices(conversationId, tasks);
        const label = choices === undefined ? undefined : choiceAt(choices, number);
        if (choices !== undefined && label !== undefined) {
          return choices.target.type === "approval"
            ? { type: "approval-label" as const, text: label }
            : {
                type: "question" as const,
                taskId: choices.target.taskId,
                questionId: choices.target.questionId,
                answer: label,
              };
        }
      }
    }
    if (parseApprovalReply(message.text) !== undefined) return undefined;
    // The tasks already read for this pass. A label is not worth a second scan of older work;
    // a number still looks those up, because an old approval card stays answerable.
    const questions = tasks.flatMap((task) =>
      task.openQuestions.map((question) => ({
        taskId: task.taskId,
        questionId: question.questionId,
        options: question.options,
      })),
    );
    const matched = singleQuestionChoice(message.text, questions);
    return matched === undefined ? undefined : { type: "question" as const, ...matched };
  });

  /**
   * A choice pressed in a task's own view of the GOAT app, for a question nobody runs to forward
   * it to (no worker): it answers that task's one matching question. An approval button or a
   * native-question option matches first, including while the task is still running. Who may
   * answer is checked where the answer is recorded.
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
    for (const card of openApprovalCards([target.task])) {
      const found = yield* ledger.approvalCodeForRequest(card.approval.requestId);
      if (found === undefined) continue;
      const labels = approvalChoiceLabels(found.code);
      if (labels[0] === trimmed || labels[1] === trimmed) {
        return { type: "approval-label" as const, text: trimmed };
      }
    }
    const hasNativeQuestion = (target.task.observed?.needsYou ?? []).some(
      (need) => need.question !== undefined && need.question.host === undefined,
    );
    if (hasNativeQuestion) {
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
