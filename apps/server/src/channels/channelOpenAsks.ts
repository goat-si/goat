import {
  type BotId,
  CHANNEL_OPEN_ASKS_DEFAULT_LIMIT,
  ChannelTask,
  type ChannelOpenAsk,
  type ChannelListOpenAsksResult,
  type ChannelTaskApprovalRef,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

import type * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { approvalCard } from "./channelApprovalCards.ts";
import { approvalRequestDetail, nativeQuestionText } from "./channelNativeQuestionCards.ts";
import { waitingTaskCondition } from "./channelWaitingTasks.ts";

/** Waiting tasks read per request; more set `truncated`. */
const CANDIDATE_LIMIT = 200;
/** Asks whose words need a read of the worker thread; later ones keep their plain words. */
const DETAIL_LIMIT = 10;

const decodeTask = Schema.decodeUnknownSync(Schema.fromJsonString(ChannelTask));

type Lookup =
  | { readonly kind: "approval"; readonly task: ChannelTask; readonly ref: ChannelTaskApprovalRef }
  | { readonly kind: "question"; readonly ref: ChannelTaskApprovalRef };

interface Draft {
  readonly ask: ChannelOpenAsk;
  readonly lookup?: Lookup;
}

const approvalWords = (task: ChannelTask, approval: ChannelTaskApprovalRef, kind?: string) =>
  approvalCard({
    card: { task, approval },
    code: "",
    bySubagent: approval.threadId !== task.worker?.threadId,
    kind: kind as Parameters<typeof approvalCard>[0]["kind"],
    prompt: undefined,
  }).text;

/** Everything one waiting task asks of the person, in the words its card or chip uses. */
const asksOf = (botId: BotId, task: ChannelTask): Array<Draft> => {
  const base = { botId, taskId: task.taskId };
  const ended = task.status === "completed" || task.status === "failed";
  const drafts: Array<Draft> = ended
    ? []
    : task.openQuestions.map((question) => ({
        ask: {
          ...base,
          kind: "question" as const,
          text: question.text,
          askedAt: question.askedAt,
          questionId: question.questionId,
        },
      }));
  for (const need of task.observed?.needsYou ?? []) {
    // Finished work can still hold an approval; nothing else it waited on is open.
    if (ended && need.kind !== "approval") continue;
    const askedAt = need.since;
    if (need.kind === "approval" && need.approval !== undefined) {
      const approval = need.approval;
      drafts.push({
        ask: {
          ...base,
          kind: "approval",
          text: approvalWords(task, approval),
          askedAt,
          requestId: approval.requestId,
        },
        ...(approval.host === undefined
          ? { lookup: { kind: "approval", task, ref: approval } }
          : {}),
      });
    } else if (need.kind === "question" && need.question !== undefined) {
      const question = need.question;
      drafts.push({
        ask: {
          ...base,
          kind: "question",
          text: task.title + " needs your answer",
          askedAt,
          requestId: question.requestId,
        },
        ...(question.host === undefined ? { lookup: { kind: "question", ref: question } } : {}),
      });
    } else if (need.kind === "sign_in") {
      drafts.push({
        ask: { ...base, kind: "sign_in", text: task.title + " needs you to sign in", askedAt },
      });
    } else if (need.kind === "usage_limit") {
      drafts.push({
        ask: {
          ...base,
          kind: "usage_limit",
          text: task.title + " is paused on a usage limit",
          askedAt,
        },
      });
    }
  }
  return drafts;
};

/**
 * What the owner's bots wait on the person for, newest first: at most `limit`, with
 * the total. Read from the same waiting tasks the bots' badges count, at most `CANDIDATE_LIMIT`
 * of them; only the newest `DETAIL_LIMIT` asks read their worker thread for exact words.
 */
export const listOpenAsks = Effect.fn("channel.listOpenAsks")(function* (input: {
  readonly sql: SqlClient.SqlClient;
  readonly threads: ThreadManagement.ThreadManagementService["Service"];
  readonly ownerId: string;
  readonly botIds: ReadonlySet<string>;
  readonly limit?: number;
}) {
  const { sql } = input;
  // Only live bots' tasks, newest ask first, so neither deleted bots nor old updates use the limit.
  const ended = sql`status IN ('completed', 'failed')`;
  const rows = yield* sql<{ readonly bot_id: string; readonly task_json: string }>`
    SELECT bot_id, task_json FROM channel_tasks
    WHERE owner_id = ${input.ownerId} AND bot_id IN ${sql.in([...input.botIds])}
      AND ${waitingTaskCondition(sql)}
    ORDER BY (
      SELECT MAX(asked_at) FROM (
        SELECT json_extract(question.value, '$.askedAt') AS asked_at
        FROM json_each(task_json, '$.openQuestions') AS question WHERE NOT ${ended}
        UNION ALL
        SELECT json_extract(need.value, '$.since')
        FROM json_each(task_json, '$.observed.needsYou') AS need
        WHERE NOT ${ended} OR json_extract(need.value, '$.kind') = 'approval'
      )
    ) DESC, updated_at DESC
    LIMIT ${CANDIDATE_LIMIT + 1}`;
  const drafts = rows
    .slice(0, CANDIDATE_LIMIT)
    .flatMap((row) => asksOf(row.bot_id as BotId, decodeTask(row.task_json)))
    .toSorted((a, b) => b.ask.askedAt.localeCompare(a.ask.askedAt));
  const shown = drafts.slice(0, input.limit ?? CHANNEL_OPEN_ASKS_DEFAULT_LIMIT);
  const looked = new Set(
    shown.filter((draft) => draft.lookup !== undefined).slice(0, DETAIL_LIMIT),
  );
  const asks = yield* Effect.forEach(
    shown,
    (draft) =>
      Effect.gen(function* () {
        const lookup = draft.lookup;
        if (lookup === undefined || !looked.has(draft)) return draft.ask;
        if (lookup.kind === "question") {
          const text = yield* nativeQuestionText(lookup.ref, input.threads);
          return text === undefined ? draft.ask : { ...draft.ask, text };
        }
        const detail = yield* approvalRequestDetail(lookup.ref, input.threads);
        return { ...draft.ask, text: approvalWords(lookup.task, lookup.ref, detail.kind) };
      }),
    { concurrency: 4 },
  );
  const result: ChannelListOpenAsksResult = {
    asks,
    total: drafts.length,
    truncated: rows.length > CANDIDATE_LIMIT,
  };
  return result;
});
