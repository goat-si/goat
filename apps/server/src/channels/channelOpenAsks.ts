import {
  type BotId,
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
import { type WaitingAsk, waitingAsks, waitingTaskCondition } from "./channelWaitingTasks.ts";

/** How many asks a client gets: the newest, which the strip names first. */
const OPEN_ASKS_LIMIT = 50;
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
const draftOf = (botId: BotId, task: ChannelTask, waiting: WaitingAsk): Draft => {
  const base = { botId, taskId: task.taskId };
  const { askedAt } = waiting;
  switch (waiting.kind) {
    case "question":
      return {
        ask: {
          ...base,
          kind: "question",
          text: waiting.question.text,
          askedAt,
          questionId: waiting.question.questionId,
        },
      };
    case "approval": {
      const approval = waiting.ref;
      return {
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
      };
    }
    case "native_question": {
      const question = waiting.ref;
      return {
        ask: {
          ...base,
          kind: "question",
          text: task.title + " needs your answer",
          askedAt,
          requestId: question.requestId,
        },
        ...(question.host === undefined ? { lookup: { kind: "question", ref: question } } : {}),
      };
    }
    case "sign_in":
      return {
        ask: { ...base, kind: "sign_in", text: task.title + " needs you to sign in", askedAt },
      };
    case "usage_limit":
      return {
        ask: {
          ...base,
          kind: "usage_limit",
          text: task.title + " is paused on a usage limit",
          askedAt,
        },
      };
  }
};

const asksOf = (botId: BotId, task: ChannelTask): Array<Draft> =>
  waitingAsks(task).map((waiting) => draftOf(botId, task, waiting));

/**
 * The live bots' waiting tasks that ask something, newest ask first, so neither deleted bots nor
 * old updates use the limit. `newest_ask_at` is null for a task with nothing to show.
 */
export const openAskCandidates = (
  sql: SqlClient.SqlClient,
  input: { readonly ownerId: string; readonly botIds: ReadonlySet<string> },
) => sql<{ readonly bot_id: string; readonly task_json: string }>`
    SELECT bot_id, task_json FROM channel_tasks
    WHERE owner_id = ${input.ownerId} AND bot_id IN ${sql.in([...input.botIds])}
      AND newest_ask_at IS NOT NULL AND ${waitingTaskCondition(sql)}
    ORDER BY newest_ask_at DESC, updated_at DESC
    LIMIT ${CANDIDATE_LIMIT + 1}`;

/**
 * What the owner's bots wait on the person for, newest first: at most `OPEN_ASKS_LIMIT`, with
 * the total. Read from the same waiting tasks the bots' badges count, at most `CANDIDATE_LIMIT`
 * of them; only the newest `DETAIL_LIMIT` asks read their worker thread for exact words.
 */
export const listOpenAsks = Effect.fn("channel.listOpenAsks")(function* (input: {
  readonly sql: SqlClient.SqlClient;
  readonly threads: ThreadManagement.ThreadManagementService["Service"];
  readonly ownerId: string;
  readonly botIds: ReadonlySet<string>;
}) {
  const rows = yield* openAskCandidates(input.sql, input);
  const drafts = rows
    .slice(0, CANDIDATE_LIMIT)
    .flatMap((row) => asksOf(row.bot_id as BotId, decodeTask(row.task_json)))
    .toSorted((a, b) => b.ask.askedAt.localeCompare(a.ask.askedAt));
  const shown = drafts.slice(0, OPEN_ASKS_LIMIT);
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
