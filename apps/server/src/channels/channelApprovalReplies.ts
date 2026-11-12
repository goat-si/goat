/**
 * Only a verb with a card's code ("Deny A1") answers an approval: a code names one request for
 * good. A bare verb or a number names nothing, so the open requests are repeated instead.
 * @module channelApprovalReplies
 */
import type { ChannelConversationId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { approvalCard, approvalTitle, type OpenApprovalCard } from "./channelApprovalCards.ts";
import { CHANNEL_COPY } from "./channelCopy.ts";
import type * as ChannelLedger from "./ChannelLedger.ts";
import { approvalRequestDetail } from "./channelNativeQuestionCards.ts";

/** Slack shows a button per label; three cards keep a clarification to six. */
const MAX_LISTED = 3;

/**
 * The ledger card can lag the thread: someone may have answered in the thread before this pass
 * rewrote the observation. A local request that is no longer pending is not an open card. A
 * remote request stays listed; this machine cannot see its status. A read failure stays listed
 * so the answer path can say it could not be passed on.
 */
export const pendingApprovals = Effect.fn("channel.pendingApprovals")(function* (
  cards: ReadonlyArray<OpenApprovalCard>,
  threads: ThreadManagement.ThreadManagementService["Service"],
) {
  const open: Array<OpenApprovalCard> = [];
  for (const card of cards) {
    const pending =
      card.approval.host !== undefined
        ? true
        : yield* threads.getThreadRecords(card.approval.threadId, ["runtimeRequests"]).pipe(
            Effect.map((records) =>
              records.runtimeRequests.some(
                (request) => request.id === card.approval.requestId && request.status === "pending",
              ),
            ),
            Effect.orElseSucceed(() => true),
          );
    if (pending) open.push(card);
  }
  return open;
});

/**
 * Each open request as its card said it, headed by its code, with that card's two words. A
 * request it can't show (no prompt, a failed read, another machine's) gets no words.
 */
export const askForApprovalCode = Effect.fn("channel.askForApprovalCode")(function* (input: {
  readonly ledger: ChannelLedger.ChannelLedger["Service"];
  readonly threads: ThreadManagement.ThreadManagementService["Service"];
  readonly conversationId: ChannelConversationId;
  readonly open: ReadonlyArray<OpenApprovalCard>;
  readonly lead: string;
}) {
  const now = DateTime.formatIso(yield* DateTime.now);
  const listed = yield* Effect.forEach(input.open.slice(0, MAX_LISTED), (card) =>
    Effect.gen(function* () {
      const detail = yield* approvalRequestDetail(card.approval, input.threads);
      const code = yield* input.ledger.issueApprovalCode({
        conversationId: input.conversationId,
        requestId: card.approval.requestId,
        now,
      });
      if (detail.prompt === undefined || detail.prompt.trim() === "") {
        const unreadable = approvalTitle(card.task) + ": " + CHANNEL_COPY.approvalDetailUnreadable;
        return { text: code + ": " + unreadable, options: [] };
      }
      const words = approvalCard({
        card,
        code,
        bySubagent: card.approval.threadId !== card.task.worker?.threadId,
        kind: detail.kind,
        prompt: detail.prompt,
      });
      return { text: code + ": " + words.text, options: words.options };
    }),
  );
  const more = input.open.length - listed.length;
  return {
    text:
      input.lead +
      listed.map((entry) => "\n\n" + entry.text).join("") +
      (more > 0 ? "\n\n" + more + CHANNEL_COPY.approvalsMoreWaiting : ""),
    options: listed.flatMap((entry) => entry.options),
    task: undefined,
    byWord: true as const,
  };
});
