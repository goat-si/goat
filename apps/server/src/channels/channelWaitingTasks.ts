import type { ChannelOpenQuestion, ChannelTask, ChannelTaskApprovalRef } from "@goat/contracts";
import type * as SqlClient from "effect/sql/SqlClient";

/**
 * A task that waits on a person: waiting for input, a running worker whose thread needs an
 * answer, approval, sign-in or resume (`observed.needsYou`), or finished work whose approval is
 * still open. The bots' waiting badges and the open asks list read this one definition.
 */
export const waitingTaskCondition = (sql: SqlClient.SqlClient) => sql`(status = 'waiting_input'
  OR (status = 'running' AND COALESCE(json_array_length(task_json, '$.observed.needsYou'), 0) > 0)
  OR (status IN ('completed', 'failed') AND EXISTS (
    SELECT 1 FROM json_each(task_json, '$.observed.needsYou')
    WHERE json_extract(value, '$.kind') = 'approval')))`;

/**
 * Whether one of a bot's tasks is going: received, dispatching or running, with nothing the chat
 * would say it waits on the person for (goatBotTaskWaitsOnPerson in client-runtime activity.ts):
 * no open question, no worker need, and no usage-limit pause, automatic or not.
 */
export const botActiveTasksStatement = (
  sql: SqlClient.SqlClient,
  input: { readonly ownerId: string; readonly botId: string },
) => sql<{ readonly active: number }>`SELECT EXISTS (SELECT 1 FROM channel_tasks
  WHERE owner_id = ${input.ownerId} AND bot_id = ${input.botId}
    AND status IN ('received', 'dispatching', 'running')
    AND COALESCE(json_array_length(task_json, '$.openQuestions'), 0) = 0
    AND COALESCE(json_array_length(task_json, '$.observed.needsYou'), 0) = 0
    AND json_extract(task_json, '$.observed.usageLimitResetAt') IS NULL) AS active`;

/** One thing a task asks of the person that the open asks list can show. */
export type WaitingAsk =
  | { readonly kind: "question"; readonly askedAt: string; readonly question: ChannelOpenQuestion }
  | {
      readonly kind: "approval" | "native_question";
      readonly askedAt: string;
      readonly ref: ChannelTaskApprovalRef;
    }
  | { readonly kind: "sign_in" | "usage_limit"; readonly askedAt: string };

/**
 * Open questions while the task runs, and each worker need that names what to answer. Finished
 * work can still hold an approval; nothing else it waited on is open.
 */
export const waitingAsks = (task: ChannelTask): Array<WaitingAsk> => {
  const ended = task.status === "completed" || task.status === "failed";
  const asks: Array<WaitingAsk> = ended
    ? []
    : task.openQuestions.map((question) => ({
        kind: "question",
        askedAt: question.askedAt,
        question,
      }));
  for (const need of task.observed?.needsYou ?? []) {
    if (ended && need.kind !== "approval") continue;
    const askedAt = need.since;
    if (need.kind === "approval" && need.approval !== undefined) {
      asks.push({ kind: "approval", askedAt, ref: need.approval });
    } else if (need.kind === "question" && need.question !== undefined) {
      asks.push({ kind: "native_question", askedAt, ref: need.question });
    } else if (need.kind === "sign_in" || need.kind === "usage_limit") {
      asks.push({ kind: need.kind, askedAt });
    }
  }
  return asks;
};

/**
 * When the newest of `waitingAsks` was made, or null without one. Stored with each task as
 * `channel_tasks.newest_ask_at`, the order the open asks list reads its candidates in.
 */
export const newestAskAt = (task: ChannelTask): string | null =>
  waitingAsks(task).reduce<string | null>(
    (newest, ask) => (newest === null || ask.askedAt > newest ? ask.askedAt : newest),
    null,
  );
