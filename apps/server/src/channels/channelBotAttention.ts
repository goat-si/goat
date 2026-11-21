import {
  type BotId,
  type ChannelGetTaskInput,
  ChannelGatewayError,
  type ChannelTask,
  type ChannelTaskEvent,
  type EnvironmentId,
} from "@goat/contracts";
import {
  type ChannelAttentionEvent,
  type ChannelAttentionFeedInput,
  type ChannelAttentionFeedResult,
  type ChannelAttentionKind,
  type GoatBotAlerts,
} from "@goat/contracts/channel-bot-attention";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import { attentionEventIdFor } from "./channelIds.ts";
import { waitingAsks } from "./channelWaitingTasks.ts";

const RETENTION_DAYS = 7;
const EVENT_LIMIT = 500;
const PAGE_SIZE = 50;

interface Ask {
  readonly kind: "question" | "approval" | "sign_in";
  readonly requestId?: string;
  readonly identity: string;
}

const asksFor = (task: ChannelTask): ReadonlyArray<Ask> =>
  waitingAsks(task).flatMap((ask): ReadonlyArray<Ask> => {
    switch (ask.kind) {
      case "question":
        return [
          {
            kind: "question",
            requestId: ask.question.questionId,
            identity: ask.question.questionId,
          },
        ];
      case "approval":
      case "native_question":
        return [
          {
            kind: ask.kind === "approval" ? "approval" : "question",
            requestId: ask.ref.requestId,
            identity: JSON.stringify([ask.ref.host ?? null, ask.ref.threadId, ask.ref.requestId]),
          },
        ];
      case "sign_in":
        return [{ kind: "sign_in", identity: ask.askedAt }];
      case "usage_limit":
        return [];
    }
  });

export const taskEventCanCreateAttention = (event: ChannelTaskEvent) =>
  event.type === "task.question.opened" ||
  event.type === "task.worker.observed" ||
  event.type === "task.completed" ||
  event.type === "task.failed";

/** Writes only newly opened asks and terminal results, under the task write's transaction. */
export const recordBotAttention = Effect.fn("channel.recordBotAttention")(function* (
  sql: SqlClient.SqlClient,
  input: {
    readonly ownerId: string;
    readonly botId: string;
    readonly before: ChannelTask;
    readonly next: ChannelTask;
    readonly event: ChannelTaskEvent;
  },
) {
  const { before, next, event, ownerId, botId } = input;
  const prior = new Set(asksFor(before).map((ask) => JSON.stringify([ask.kind, ask.identity])));
  const added: ReadonlyArray<{ kind: ChannelAttentionKind; identity: string; requestId?: string }> =
    event.type === "task.completed" || event.type === "task.failed"
      ? [{ kind: event.type === "task.completed" ? "finished" : "failed", identity: "" }]
      : asksFor(next).filter((ask) => !prior.has(JSON.stringify([ask.kind, ask.identity])));
  if (added.length === 0) return;
  for (const entry of added) {
    const eventId = attentionEventIdFor(
      next.taskId,
      next.generation,
      JSON.stringify([entry.kind, entry.identity]),
    );
    yield* sql`INSERT INTO channel_bot_attention
      (owner_id, bot_id, task_id, event_id, kind, request_id, generation, occurred_at)
      VALUES (${ownerId}, ${botId}, ${next.taskId}, ${eventId}, ${entry.kind},
        ${entry.requestId ?? null}, ${next.generation}, ${event.occurredAt})
      ON CONFLICT(event_id) DO NOTHING`;
  }
  const cutoff = DateTime.formatIso(
    DateTime.subtract(yield* DateTime.now, { days: RETENTION_DAYS }),
  );
  yield* sql`DELETE FROM channel_bot_attention WHERE owner_id = ${ownerId} AND (
    occurred_at < ${cutoff} OR sequence < COALESCE((
      SELECT sequence FROM channel_bot_attention WHERE owner_id = ${ownerId}
      ORDER BY sequence DESC LIMIT 1 OFFSET ${EVENT_LIMIT - 1}
    ), 0)
  )`;
});

export const readBotAttention = Effect.fn("channel.readBotAttention")(function* (
  sql: SqlClient.SqlClient,
  input: {
    readonly ownerId: string;
    readonly environmentId: EnvironmentId;
    readonly mode: GoatBotAlerts;
    readonly names: ReadonlyMap<BotId, string>;
    readonly request: ChannelAttentionFeedInput;
  },
) {
  const { ownerId, environmentId, names, mode } = input;
  const cursor = input.request.cursor;
  if (cursor === undefined) {
    const rows = yield* sql<{ sequence: number }>`SELECT COALESCE(MAX(sequence), 0) AS sequence
      FROM channel_bot_attention WHERE owner_id = ${ownerId}`;
    return {
      cursor: rows[0]?.sequence ?? 0,
      hasMore: false,
      mode,
      events: [],
    } satisfies ChannelAttentionFeedResult;
  }
  const cutoff = DateTime.formatIso(
    DateTime.subtract(yield* DateTime.now, { days: RETENTION_DAYS }),
  );
  const rows = yield* sql<{
    sequence: number;
    bot_id: BotId;
    task_id: ChannelTask["taskId"];
    event_id: string;
    kind: ChannelAttentionKind;
    request_id: string | null;
    generation: number;
    occurred_at: string;
  }>`SELECT sequence, bot_id, task_id, event_id, kind, request_id, generation, occurred_at
    FROM channel_bot_attention
    WHERE owner_id = ${ownerId} AND sequence > ${cursor} AND occurred_at >= ${cutoff}
    ORDER BY sequence LIMIT ${PAGE_SIZE + 1}`;
  const page = rows.slice(0, PAGE_SIZE);
  const events = page.flatMap((row): ReadonlyArray<ChannelAttentionEvent> => {
    const botName = names.get(row.bot_id);
    if (botName === undefined) return [];
    return [
      {
        eventId: row.event_id,
        sequence: row.sequence,
        kind: row.kind,
        environmentId,
        botId: row.bot_id,
        botName,
        taskId: row.task_id,
        ...(row.request_id === null ? {} : { requestId: row.request_id }),
        generation: row.generation,
        occurredAt: row.occurred_at,
      },
    ];
  });
  return {
    cursor: page.at(-1)?.sequence ?? cursor,
    hasMore: rows.length > PAGE_SIZE,
    mode,
    events,
  } satisfies ChannelAttentionFeedResult;
});

export const readTaskForAttention = Effect.fn("channel.readTaskForAttention")(
  function* (
    ledger: import("./ChannelLedger.ts").ChannelLedger["Service"],
    input: ChannelGetTaskInput,
    ownerId: string,
  ) {
    const stored = yield* ledger.getTask(input.taskId);
    if (
      stored === undefined ||
      stored.ownerId !== ownerId ||
      (input.botId !== undefined && stored.botId !== input.botId)
    ) {
      return yield* new ChannelGatewayError({ reason: "not_found" });
    }
    const { task } = stored;
    if (input.attentionRequest === undefined) return task;
    const records = task.answeredQuestions ?? [];
    const answered = records.find((record) => record.questionId === input.attentionRequest);
    if (answered?.inputId === undefined) return task;
    const answer = yield* ledger.getInput(answered.inputId);
    return answer?.ownerId === ownerId
      ? {
          ...task,
          answeredQuestions: records.map((record) =>
            record === answered ? { ...record, answerText: answer.message.text } : record,
          ),
        }
      : task;
  },
  Effect.mapError((error) =>
    error._tag === "ChannelGatewayError"
      ? error
      : new ChannelGatewayError({ reason: "persistence_failed" }),
  ),
);
