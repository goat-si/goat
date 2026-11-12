/**
 * A GOAT Bot turn that asked the person waits only until their next message in its conversation.
 * Session routing runs that message as a new turn on the same session, which carries the question
 * on, so the asking turn records that message as its answer and ends without another reply.
 *
 * @module channelSupersededTurns
 */
import { isGoatBotSessionThreadId, type ChannelTask } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type * as ChannelLedger from "./ChannelLedger.ts";
import { taskEventIdFor } from "./channelIds.ts";
import { prepareTransition } from "./channelTaskWrites.ts";

/** The asker's first turn after the turn's newest question; a coding thread's ask is excluded. */
const supersedingTurn = (
  asking: ChannelTask,
  conversation: ReadonlyArray<ChannelTask>,
): ChannelTask | undefined => {
  const worker = asking.worker;
  if (
    asking.kind !== "turn" ||
    asking.status !== "waiting_input" ||
    asking.openQuestions.length === 0 ||
    asking.skillProposal !== undefined ||
    (asking.observed?.needsYou.length ?? 0) > 0 ||
    worker === undefined ||
    worker.host !== undefined ||
    !isGoatBotSessionThreadId(worker.threadId)
  )
    return undefined;
  const askedAt = Math.max(...asking.openQuestions.map((question) => Date.parse(question.askedAt)));
  return conversation
    .filter(
      (other) =>
        other.taskId !== asking.taskId &&
        other.kind === "turn" &&
        other.requester.principalId === asking.requester.principalId &&
        Date.parse(other.createdAt) > askedAt,
    )
    .toSorted((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))[0];
};

/** Settles `stored` when a later turn took the person's reply; false when it still waits. */
export const settleSupersededTurn = Effect.fn("channelSupersededTurns.settle")(function* (
  ledger: ChannelLedger.ChannelLedger["Service"],
  stored: ChannelLedger.ChannelStoredTask,
  owner: string,
) {
  if (stored.task.kind !== "turn" || stored.task.status !== "waiting_input") return false;
  const later = supersedingTurn(
    stored.task,
    yield* ledger.listConversationTasks(stored.task.conversationId),
  );
  if (later === undefined) return false;
  const bot = (yield* ledger.getBotById(stored.ownerId, stored.botId))?.bot;
  const now = DateTime.formatIso(yield* DateTime.now);
  const step = (
    current: ChannelLedger.ChannelStoredTask,
    spec: Parameters<typeof prepareTransition>[1],
    last: boolean,
  ) =>
    prepareTransition(current, spec, now, last ? bot : undefined, {
      actor: "system",
      eventId: taskEventIdFor(current.task.taskId, current.task.version + 1),
    });
  const writes: Array<Extract<ReturnType<typeof prepareTransition>, { ok: true }>> = [];
  let current = stored;
  for (const question of stored.task.openQuestions) {
    const answered = step(
      current,
      {
        type: "task.question.answered",
        payload: {
          questionId: question.questionId,
          answer: later.instruction,
          inputId: later.originInputId,
        },
      },
      false,
    );
    if (!answered.ok) return false;
    writes.push(answered);
    current = { ...stored, task: answered.next };
  }
  // An empty turn summary narrates nothing: the later turn answers the person.
  const ended = step(
    current,
    {
      type: "task.completed",
      payload: {
        generation: current.task.generation,
        ...(current.task.worker?.runId === undefined ? {} : { runId: current.task.worker.runId }),
        summary: "",
      },
    },
    true,
  );
  if (!ended.ok) return false;
  writes.push(ended);
  return yield* ledger
    .underWorkerLock(
      owner,
      Effect.forEach(
        writes,
        (prepared) =>
          ledger.applyTaskEvent({ owner, write: prepared.write, deliveries: prepared.deliveries }),
        { discard: true },
      ),
    )
    .pipe(
      Effect.as(true),
      // Another writer moved the task first; the next pass judges it again.
      Effect.catchIf(
        (error) => error.reason === "version_conflict",
        () => Effect.succeed(false),
      ),
    );
});
