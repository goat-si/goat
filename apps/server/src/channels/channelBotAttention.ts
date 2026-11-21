import {
  type BotId,
  type ChannelGetTaskInput,
  ChannelGatewayError,
  type ChannelTask,
  type ChannelTaskEvent,
  type EnvironmentId,
  type OrchestrationV2StoredEvent,
  RuntimeRequestId,
} from "@goat/contracts";
import {
  type ChannelAttentionEvent,
  type ChannelAttentionFeedInput,
  type ChannelAttentionFeedResult,
  type ChannelAttentionKind,
  ChannelAttentionRequest,
  type GoatBotAlerts,
} from "@goat/contracts/channel-bot-attention";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { attentionEventIdFor } from "./channelIds.ts";
import { waitingAsks } from "./channelWaitingTasks.ts";

const RETENTION_DAYS = 7;
const EVENT_LIMIT = 500;
const PAGE_SIZE = 50;
const expiryCutoff = Effect.map(DateTime.now, (now) =>
  DateTime.formatIso(DateTime.subtract(now, { days: RETENTION_DAYS })),
);

export const layerBotAttentionExpiry = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* Effect.gen(function* () {
      const cutoff = yield* expiryCutoff;
      yield* sql`DELETE FROM channel_bot_attention WHERE sequence IN (
        SELECT sequence FROM channel_bot_attention WHERE occurred_at <= ${cutoff}
        ORDER BY occurred_at, sequence LIMIT ${EVENT_LIMIT}
      )`;
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not expire GOAT Bot attention events", { cause }),
      ),
      Effect.repeat(Schedule.spaced("15 minutes")),
      Effect.forkScoped,
    );
  }),
);

interface Ask {
  readonly kind: "question" | "approval" | "sign_in";
  readonly requestId?: string;
  readonly request?: ChannelAttentionRequest;
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
      case "handoff":
      case "native_question":
        return [
          {
            kind: ask.kind === "native_question" ? "question" : "approval",
            requestId: ask.ref.requestId,
            request: { kind: ask.kind === "handoff" ? "handoff" : "runtime", ...ask.ref },
            identity:
              (ask.kind === "handoff" ? "handoff:" : "") +
              JSON.stringify([ask.ref.host ?? null, ask.ref.threadId, ask.ref.requestId]),
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
  const prior = new Set(asksFor(before).map((ask) => ask.kind + ":" + ask.identity));
  const added: ReadonlyArray<{
    kind: ChannelAttentionKind;
    identity: string;
    requestId?: string;
    request?: ChannelAttentionRequest;
  }> =
    event.type === "task.completed" || event.type === "task.failed"
      ? [{ kind: event.type === "task.completed" ? "finished" : "failed", identity: "" }]
      : asksFor(next).filter((ask) => !prior.has(ask.kind + ":" + ask.identity));
  if (added.length === 0) return;
  for (const entry of added) {
    const eventId = attentionEventIdFor(
      next.taskId,
      next.generation,
      entry.kind + ":" + entry.identity,
    );
    yield* sql`INSERT INTO channel_bot_attention
      (owner_id, bot_id, task_id, event_id, kind, request_id, generation, occurred_at)
      VALUES (${ownerId}, ${botId}, ${next.taskId}, ${eventId}, ${entry.kind},
        ${entry.request === undefined ? (entry.requestId ?? null) : encodeRequest(entry.request)}, ${next.generation}, ${event.occurredAt})
      ON CONFLICT(event_id) DO NOTHING`;
  }
  yield* pruneOwner(sql, ownerId);
});

// Preview rows stored plain IDs in this column and remain readable after the upgrade.
const requestJson = Schema.fromJsonString(ChannelAttentionRequest);
const encodeRequest = Schema.encodeSync(requestJson);
const decodeRequest = Schema.decodeUnknownOption(requestJson);

const pruneOwner = Effect.fn("channel.pruneBotAttention")(function* (
  sql: SqlClient.SqlClient,
  ownerId: string,
) {
  const cutoff = yield* expiryCutoff;
  yield* sql`DELETE FROM channel_bot_attention WHERE owner_id = ${ownerId} AND (
    occurred_at <= ${cutoff} OR sequence < COALESCE((
      SELECT sequence FROM channel_bot_attention WHERE owner_id = ${ownerId}
      ORDER BY sequence DESC LIMIT 1 OFFSET ${EVENT_LIMIT - 1}
    ), 0)
  )`;
});

export const recordBotHandoffAttention = Effect.fn("channel.recordBotHandoffAttention")(function* (
  sql: SqlClient.SqlClient,
  events: ReadonlyArray<OrchestrationV2StoredEvent>,
) {
  for (const { event } of events) {
    if (event.type !== "turn-item.updated" || event.payload.type !== "human_handoff") continue;
    const { handoff, threadId } = event.payload;
    if (handoff.kind !== "approval" || handoff.state !== "pending") continue;
    const request = encodeRequest({
      kind: "handoff",
      threadId,
      requestId: RuntimeRequestId.make(handoff.handoffId),
    });
    const inserted = yield* sql<{ owner_id: string }>`INSERT INTO channel_bot_attention
      (owner_id, bot_id, task_id, event_id, kind, request_id, generation, occurred_at)
      SELECT task.owner_id, task.bot_id, task.task_id, ${"handoff:" + handoff.handoffId}, 'approval',
        ${request}, task.generation, ${DateTime.formatIso(handoff.createdAt)}
      FROM channel_tasks AS task
      WHERE task.worker_thread_id = ${threadId}
        AND task.status IN ('running', 'waiting_input')
        AND json_extract(task.task_json, '$.worker.environmentId') = ${handoff.target.environmentId}
        AND json_extract(task.task_json, '$.worker.host') IS NULL
      ORDER BY task.updated_at DESC, task.task_id
      LIMIT 1
      ON CONFLICT(event_id) DO NOTHING
      RETURNING owner_id`;
    for (const { owner_id } of inserted) yield* pruneOwner(sql, owner_id);
  }
});

export const readBotAttention = Effect.fn("channel.readBotAttention")(function* <E>(
  sql: SqlClient.SqlClient,
  input: {
    readonly ownerId: string;
    readonly environmentId: EnvironmentId;
    readonly mode: GoatBotAlerts;
    readonly resolveName: (botId: BotId) => Effect.Effect<string | undefined, E>;
    readonly request: ChannelAttentionFeedInput;
  },
) {
  const { ownerId, environmentId, resolveName, mode } = input;
  const { cursor, worker } = input.request;
  if (worker !== undefined) {
    const rows = yield* sql`SELECT 1 FROM channel_tasks
      WHERE worker_thread_id = ${worker.threadId}
        AND owner_id = ${ownerId}
        AND json_extract(task_json, '$.worker.environmentId') = ${worker.environmentId}
        AND json_extract(task_json, '$.worker.host') IS NOT NULL
      LIMIT 1`;
    return {
      cursor: 0,
      hasMore: false,
      mode,
      events: [],
      ownsWorker: rows.length > 0,
    } satisfies ChannelAttentionFeedResult;
  }
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
  const cutoff = yield* expiryCutoff;
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
    WHERE owner_id = ${ownerId} AND sequence > ${cursor} AND occurred_at > ${cutoff}
    ORDER BY sequence LIMIT ${PAGE_SIZE + 1}`;
  const page = rows.slice(0, PAGE_SIZE);
  const names = new Map<BotId, string | undefined>();
  for (const botId of new Set(page.map((row) => row.bot_id))) {
    names.set(botId, yield* resolveName(botId));
  }
  const events = page.flatMap((row): ReadonlyArray<ChannelAttentionEvent> => {
    const botName = names.get(row.bot_id);
    if (botName === undefined) return [];
    const request =
      row.request_id === null ? undefined : Option.getOrUndefined(decodeRequest(row.request_id));
    const requestId = request?.requestId ?? row.request_id;
    return [
      {
        eventId: row.event_id,
        sequence: row.sequence,
        kind: row.kind,
        environmentId,
        botId: row.bot_id,
        botName,
        taskId: row.task_id,
        ...(requestId === null ? {} : { requestId }),
        ...(request === undefined ? {} : { request }),
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
