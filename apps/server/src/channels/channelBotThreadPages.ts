import {
  CHANNEL_BOT_THREADS_EARLIER_PAGE_LIMIT,
  CHANNEL_BOT_THREADS_FIRST_PAGE_LIMIT,
  CHANNEL_BOT_THREADS_PINNED_LIMIT,
  ChannelGatewayError,
  ChannelTask,
  type ChannelBotThreadsPage,
  type ChannelTaskView,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import type * as Statement from "effect/sql/Statement";

const decodeTask = Schema.decodeUnknownSync(Schema.fromJsonString(ChannelTask));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

interface FinishKey {
  readonly finish: string;
  readonly taskId: string;
}
interface Candidate extends FinishKey {
  readonly task: ChannelTask;
}
interface FinishedRow extends FinishKey {
  readonly json: string;
  /** A finished bot turn, listed by the threads it launched. */
  readonly threadsOnly?: boolean;
}
// SQLite's BINARY order, which the index and the keyset use.
const newestFirst = (a: FinishKey, b: FinishKey) =>
  a.finish === b.finish
    ? a.taskId === b.taskId
      ? 0
      : a.taskId < b.taskId
        ? 1
        : -1
    : a.finish < b.finish
      ? 1
      : -1;

// An empty task id means everything that finished before that time.
const encodeCursor = (key: FinishKey) => key.finish + "|" + key.taskId;
const decodeCursor = (cursor: string) => {
  const separator = cursor.indexOf("|");
  const finish = cursor.slice(0, separator);
  const taskId = cursor.slice(separator + 1);
  return separator > 0 && !Number.isNaN(Date.parse(finish))
    ? Effect.succeed({ finish, taskId })
    : Effect.fail(new ChannelGatewayError({ reason: "invalid_input" }));
};

/**
 * A bot's finished work tasks after a key, newest finish first, read in order from
 * channel_tasks_owner_bot_finished. Its terms repeat the index's own so SQLite can use it, and
 * the redundant "<=" bounds the scan at the cursor.
 */
export const finishedWorkStatement = (
  sql: SqlClient.SqlClient,
  input: {
    readonly ownerId: string;
    readonly botId: string;
    readonly pinned: ReadonlyArray<string>;
    readonly after: FinishKey | undefined;
    readonly limit: number;
  },
) => {
  const after =
    input.after === undefined
      ? sql``
      : sql`AND COALESCE(json_extract(t.task_json, '$.completedAt'), t.updated_at) <= ${input.after.finish}
        AND (COALESCE(json_extract(t.task_json, '$.completedAt'), t.updated_at) < ${input.after.finish}
          OR t.task_id < ${input.after.taskId})`;
  return sql<{
    readonly task_json: string;
    readonly finish: string;
    readonly task_id: string;
  }>`SELECT t.task_json, t.task_id,
      COALESCE(json_extract(t.task_json, '$.completedAt'), t.updated_at) AS finish
    FROM channel_tasks t
    WHERE t.owner_id = ${input.ownerId} AND t.bot_id = ${input.botId}
      AND t.status IN ('completed', 'failed', 'cancelled')
      AND COALESCE(json_extract(t.task_json, '$.kind'), 'work') != 'turn'
      AND EXISTS (SELECT 1 FROM channel_conversations c WHERE c.conversation_id = t.conversation_id
        AND c.owner_id = ${input.ownerId} AND c.kind = 'goat')
      AND t.task_id NOT IN (SELECT value FROM json_each(${encodeJson(input.pinned)}))
      ${after}
    ORDER BY COALESCE(json_extract(t.task_json, '$.completedAt'), t.updated_at) DESC, t.task_id DESC
    LIMIT ${input.limit}`;
};

export interface BotThreadPage {
  /** In the order listed: pinned, running, then finished work. */
  readonly tasks: ReadonlyArray<ChannelTask>;
  /** Finished bot turns, listed by the threads they launched; their answer is in the chat. */
  readonly threadsOnly: ReadonlySet<string>;
  readonly page: {
    readonly earlierCursor?: string;
    readonly pinnedTruncated?: boolean;
    readonly activeTruncated?: boolean;
    readonly unreadCount?: number;
  };
}

/**
 * One page of a bot's work. Pinned tasks and running work are on the first page, each under its
 * own cap; finished work is one sequence by finish time and task id, which the first page starts
 * with what finished since the cutoff and earlier pages continue from a cursor. completedAt stays
 * fixed while a task is finished, so a cursor neither skips nor repeats a task that keeps its state.
 */
export const readBotThreadPage = Effect.fn("ChannelBotThreads.readPage")(function* (
  sql: SqlClient.SqlClient,
  input: {
    readonly ownerId: string;
    readonly botId: string;
    readonly page: ChannelBotThreadsPage;
    readonly pinned: ReadonlyArray<string>;
    readonly cutoffIso: string;
    readonly nowIso: string;
    readonly viewsByTask: ReadonlyMap<string, ChannelTaskView>;
  },
) {
  const { ownerId, botId, pinned } = input;
  const after = input.page.kind === "first" ? undefined : yield* decodeCursor(input.page.cursor);
  const goat = sql`EXISTS (SELECT 1 FROM channel_conversations c
    WHERE c.conversation_id = t.conversation_id AND c.owner_id = ${ownerId} AND c.kind = 'goat')`;
  // A turn is listed while work it launched lives, and once it ended by the threads it launched.
  // Both read only turns with child work, found through the child work records (key range).
  const liveChild = sql`EXISTS (SELECT 1 FROM channel_runtime_state s
    WHERE s.key >= ('child-work:' || t.task_id || ':') AND s.key < ('child-work:' || t.task_id || ';')
      AND json_extract(s.value_json, '$.generation') = t.generation
      AND json_extract(s.value_json, '$.state') IN ('launched', 'bound', 'unknown'))`;
  const turnsWith = (condition: Statement.Fragment) =>
    sql`t.task_id IN (SELECT json_extract(s.value_json, '$.taskId') FROM channel_runtime_state s
      WHERE s.key >= 'child-work:' AND s.key < 'child-work;'
        AND json_extract(s.value_json, '$.ownerId') = ${ownerId} AND (${condition}))
      AND t.owner_id = ${ownerId} AND t.bot_id = ${botId}
      AND json_extract(t.task_json, '$.kind') = 'turn' AND ${goat}`;
  const launched = sql`(json_extract(s.value_json, '$.surface') = 'thread_launch'
      AND json_extract(s.value_json, '$.destination.threadId') IS NOT NULL)
    OR (json_extract(s.value_json, '$.surface') = 'ssh_thread_launch'
      AND json_extract(s.value_json, '$.destination.host') IS NOT NULL
      AND json_extract(s.value_json, '$.state') != 'released')`;
  const finishedPage = Effect.fn("ChannelBotThreads.finishedPage")(function* (limit: number) {
    const work = yield* finishedWorkStatement(sql, {
      ownerId,
      botId,
      pinned,
      after,
      limit: limit + 1,
    });
    const bound =
      after === undefined
        ? sql``
        : sql`AND COALESCE(json_extract(t.task_json, '$.completedAt'), t.updated_at) <= ${after.finish}
          AND (COALESCE(json_extract(t.task_json, '$.completedAt'), t.updated_at) < ${after.finish}
            OR t.task_id < ${after.taskId})`;
    const turns = yield* sql<{
      readonly task_json: string;
      readonly task_id: string;
      readonly finish: string;
    }>`SELECT t.task_json, t.task_id,
        COALESCE(json_extract(t.task_json, '$.completedAt'), t.updated_at) AS finish
      FROM channel_tasks t
      WHERE ${turnsWith(launched)}
        AND t.status IN ('completed', 'failed', 'cancelled') AND NOT ${liveChild} ${bound}
      ORDER BY finish DESC, t.task_id DESC LIMIT ${limit + 1}`;
    // The first limit + 1 of both, merged, are exact: each query stopped at limit + 1.
    return [
      ...work.map((row): FinishedRow => ({
        finish: row.finish,
        taskId: row.task_id,
        json: row.task_json,
      })),
      ...turns.map((row): FinishedRow => ({
        finish: row.finish,
        taskId: row.task_id,
        json: row.task_json,
        threadsOnly: true,
      })),
    ].sort(newestFirst);
  });
  const decode = (rows: ReadonlyArray<FinishedRow>) =>
    Effect.try(() => rows.map((row): Candidate => ({ ...row, task: decodeTask(row.json) }))).pipe(
      Effect.mapError(() => new ChannelGatewayError({ reason: "persistence_failed" })),
    );
  const threadsOnlyOf = (rows: ReadonlyArray<FinishedRow>) =>
    new Set(rows.flatMap((row) => (row.threadsOnly === true ? [row.taskId] : [])));

  if (input.page.kind === "earlier") {
    const merged = yield* finishedPage(CHANNEL_BOT_THREADS_EARLIER_PAGE_LIMIT);
    const page = merged.slice(0, CHANNEL_BOT_THREADS_EARLIER_PAGE_LIMIT);
    const taken = yield* decode(page);
    const last = taken.at(-1);
    return {
      tasks: taken.map((row) => row.task),
      threadsOnly: threadsOnlyOf(page),
      page:
        last !== undefined && merged.length > taken.length
          ? { earlierCursor: encodeCursor(last) }
          : {},
    } satisfies BotThreadPage;
  }

  const pinnedRows = yield* sql<{
    readonly task_json: string;
    readonly task_id: string;
  }>`SELECT t.task_json, t.task_id
    FROM channel_tasks t
    WHERE t.task_id IN (SELECT value FROM json_each(${encodeJson(pinned)}))
      AND t.owner_id = ${ownerId} AND t.bot_id = ${botId}
      AND COALESCE(json_extract(t.task_json, '$.kind'), 'work') != 'turn' AND ${goat}
    ORDER BY t.updated_at DESC, t.task_id DESC LIMIT ${CHANNEL_BOT_THREADS_PINNED_LIMIT + 1}`;
  const live = sql`json_extract(s.value_json, '$.state') IN ('launched', 'bound', 'unknown')`;
  const active = yield* sql<{
    readonly task_json: string;
    readonly task_id: string;
    readonly updated_at: string;
  }>`SELECT task_json, task_id, updated_at FROM (
      SELECT t.task_json, t.task_id, t.updated_at
      FROM channel_tasks t
      WHERE t.owner_id = ${ownerId} AND t.bot_id = ${botId}
        AND t.status IN ('received', 'dispatching', 'running', 'waiting_input')
        AND COALESCE(json_extract(t.task_json, '$.kind'), 'work') != 'turn' AND ${goat}
        AND t.task_id NOT IN (SELECT value FROM json_each(${encodeJson(pinned)}))
      UNION ALL
      SELECT t.task_json, t.task_id, t.updated_at
      FROM channel_tasks t
      WHERE ${turnsWith(live)} AND ${liveChild})
    ORDER BY updated_at DESC, task_id DESC LIMIT ${CHANNEL_BOT_THREADS_FIRST_PAGE_LIMIT + 1}`;
  const activeTaken = active.slice(0, CHANNEL_BOT_THREADS_FIRST_PAGE_LIMIT);
  const slots = CHANNEL_BOT_THREADS_FIRST_PAGE_LIMIT - activeTaken.length;
  const merged = yield* finishedPage(slots);
  const recent: Array<(typeof merged)[number]> = [];
  for (const row of merged) {
    if (recent.length >= slots || row.finish < input.cutoffIso) break;
    recent.push(row);
  }
  // One transaction reads every set, so a task is in one; this only guards that invariant.
  const listed = new Set([...pinnedRows, ...activeTaken].map((row) => row.task_id));
  const finished = yield* decode(recent.filter((row) => !listed.has(row.taskId)));
  const tasks = yield* Effect.try(() => [
    ...pinnedRows
      .slice(0, CHANNEL_BOT_THREADS_PINNED_LIMIT)
      .map((row) => decodeTask(row.task_json)),
    ...activeTaken.map((row) => decodeTask(row.task_json)),
    ...finished.map((row) => row.task),
  ]).pipe(Effect.mapError(() => new ChannelGatewayError({ reason: "persistence_failed" })));

  // Every unread task row any page lists: the bot's work tasks, and its turns while they run.
  const reads = encodeJson(
    [...input.viewsByTask.values()].flatMap((view) => {
      const at = view.readThrough === null ? Number.NaN : Date.parse(view.readThrough);
      return Number.isNaN(at)
        ? []
        : [{ taskId: view.taskId, readThrough: DateTime.formatIso(DateTime.makeUnsafe(at)) }];
    }),
  );
  const listedTask = sql`(COALESCE(json_extract(t.task_json, '$.kind'), 'work') != 'turn'
    OR ${liveChild})`;
  // Walks the bot's tasks once per first page; it returns only the two counts.
  const counts = yield* sql<{ readonly total: number; readonly read: number }>`SELECT
      (SELECT count(*) FROM channel_tasks t
        WHERE t.owner_id = ${ownerId} AND t.bot_id = ${botId}
          AND t.status IN ('completed', 'failed', 'cancelled')
          AND COALESCE(json_extract(t.task_json, '$.kind'), 'work') != 'turn' AND ${goat})
      + (SELECT count(*) FROM channel_tasks t
        WHERE t.owner_id = ${ownerId} AND t.bot_id = ${botId}
          AND t.status IN ('received', 'dispatching', 'running', 'waiting_input')
          AND COALESCE(json_extract(t.task_json, '$.kind'), 'work') != 'turn' AND ${goat})
      + (SELECT count(*) FROM channel_tasks t WHERE ${turnsWith(live)} AND ${liveChild}) AS total,
      (SELECT count(*) FROM json_each(${reads}) r
        JOIN channel_tasks t ON t.task_id = json_extract(r.value, '$.taskId')
        WHERE t.owner_id = ${ownerId} AND t.bot_id = ${botId} AND ${goat} AND ${listedTask}
          AND strftime('%Y-%m-%dT%H:%M:%fZ', t.updated_at) <= json_extract(r.value, '$.readThrough')) AS read`;
  const total = counts[0]?.total ?? 0;
  const read = counts[0]?.read ?? 0;
  return {
    tasks,
    threadsOnly: threadsOnlyOf(recent),
    page: {
      ...(merged.length > recent.length
        ? {
            // With no finished row taken, earlier pages start where this page stopped looking:
            // the cutoff, or now when running work took every slot. Work finishing later sorts
            // above it, so it reaches the next first page and never an earlier one.
            earlierCursor: encodeCursor(
              recent.at(-1) ?? { finish: slots === 0 ? input.nowIso : input.cutoffIso, taskId: "" },
            ),
          }
        : {}),
      pinnedTruncated: pinnedRows.length > CHANNEL_BOT_THREADS_PINNED_LIMIT,
      activeTruncated: active.length > CHANNEL_BOT_THREADS_FIRST_PAGE_LIMIT,
      unreadCount: Math.max(0, total - read),
    },
  } satisfies BotThreadPage;
});
