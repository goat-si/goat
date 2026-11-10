import type { BotId, ChannelOpenAsk, ChannelTask } from "@goat/contracts";
import * as Effect from "effect/Effect";

import type * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { approvalCard, openApprovalCards } from "./channelApprovalCards.ts";
import { approvalRequestDetail } from "./channelNativeQuestionCards.ts";

/** How many asks a client gets; the newest ones, which the strip names first. */
const OPEN_ASKS_LIMIT = 50;

/**
 * Everything one bot's tasks wait on the person for: questions the task asked, with their words,
 * and worker approvals and questions, worded as the card that asks them.
 */
export const openAsksFor = Effect.fn("channel.openAsksFor")(function* (
  botId: BotId,
  tasks: ReadonlyArray<ChannelTask>,
  threads: ThreadManagement.ThreadManagementService["Service"],
) {
  const asks: Array<ChannelOpenAsk> = [];
  for (const task of tasks) {
    for (const question of task.openQuestions) {
      asks.push({
        botId,
        taskId: task.taskId,
        kind: "question",
        text: question.text,
        askedAt: question.askedAt,
        questionId: question.questionId,
      });
    }
    for (const card of openApprovalCards([task])) {
      const detail =
        card.approval.host === undefined
          ? yield* approvalRequestDetail(card.approval, threads)
          : undefined;
      const words = approvalCard({
        card,
        code: "",
        bySubagent: card.approval.threadId !== task.worker?.threadId,
        kind: detail?.kind,
        prompt: undefined,
      });
      const since = (task.observed?.needsYou ?? []).find(
        (need) => need.approval?.requestId === card.approval.requestId,
      )?.since;
      asks.push({
        botId,
        taskId: task.taskId,
        kind: "approval",
        text: words.text,
        askedAt: since ?? task.updatedAt,
        requestId: card.approval.requestId,
      });
    }
    for (const need of task.observed?.needsYou ?? []) {
      if (need.question === undefined) continue;
      asks.push({
        botId,
        taskId: task.taskId,
        kind: "question",
        text: task.title + " needs your answer",
        askedAt: need.since,
        requestId: need.question.requestId,
      });
    }
  }
  return asks;
});

/** All bots' asks, newest first, at most `OPEN_ASKS_LIMIT`. */
export const newestAsks = (asks: ReadonlyArray<ChannelOpenAsk>): ReadonlyArray<ChannelOpenAsk> =>
  asks.toSorted((a, b) => b.askedAt.localeCompare(a.askedAt)).slice(0, OPEN_ASKS_LIMIT);
