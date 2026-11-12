import {
  CHANNEL_BOT_THREADS_CURSOR_MAX_LENGTH,
  CHANNEL_BOT_THREADS_HISTORY_LIMIT,
  ChannelGatewayError,
  ChannelTask,
  type ChannelTaskId,
} from "@goat/contracts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a synchronous digest keeps the cursor codec pure.
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

const decodeTask = Schema.decodeUnknownSync(Schema.fromJsonString(ChannelTask));
// [botTag, ownerTag, createdAt, taskId]
const CursorBody = Schema.fromJsonString(
  Schema.Tuple([Schema.String, Schema.String, Schema.String, Schema.String]),
);
const encodeBody = Schema.encodeSync(CursorBody);
const decodeBody = Schema.decodeUnknownEffect(CursorBody);
const MAX_CREATED_AT = 64;
const MAX_TASK_ID = 200;
/**
 * The most tasks one history request examines, listed or not, plus one lookahead row that only
 * tells whether the walk goes on; a long chat of turns that launched nothing cannot make one page
 * read a bot's whole history. Small enough to cost a few thousand index steps, large enough that
 * most pages fill.
 */
export const CHANNEL_BOT_THREADS_HISTORY_EXAMINED = 500;
/** Clients compare a row's main-message count only with 10 (botRowRetiresAt), so history stops there. */
const HISTORY_QUIET_MESSAGES_CAP = 10;
const invalid = () => new ChannelGatewayError({ reason: "invalid_input" });

interface HistoryKey {
  readonly createdAt: string;
  readonly taskId: string;
}
interface CursorScope {
  readonly ownerId: string;
  readonly botId: string;
}

// The tags keep a cursor from being used for another owner or bot by mistake; they are no secret.
const tag = (value: string) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex").slice(0, 16);

export const encodeHistoryCursor = (scope: CursorScope, key: HistoryKey) =>
  "v1." +
  Buffer.from(
    encodeBody([tag(scope.botId), tag(scope.ownerId), key.createdAt, key.taskId]),
  ).toString("base64url");

/** The key a cursor this server issued for the same owner and bot names; anything else is refused. */
export const decodeHistoryCursor = Effect.fn("ChannelBotThreads.decodeHistoryCursor")(function* (
  scope: CursorScope,
  cursor: string,
) {
  if (cursor.length > CHANNEL_BOT_THREADS_CURSOR_MAX_LENGTH || !cursor.startsWith("v1."))
    return yield* invalid();
  const [botTag, ownerTag, createdAt, taskId] = yield* decodeBody(
    Buffer.from(cursor.slice(3), "base64url").toString("utf8"),
  ).pipe(Effect.mapError(invalid));
  if (
    botTag !== tag(scope.botId) ||
    ownerTag !== tag(scope.ownerId) ||
    createdAt.length === 0 ||
    createdAt.length > MAX_CREATED_AT ||
    taskId.length === 0 ||
    taskId.length > MAX_TASK_ID
  )
    return yield* invalid();
  const key = { createdAt, taskId };
  if (encodeHistoryCursor(scope, key) !== cursor) return yield* invalid();
  return key;
});

/**
 * A launch with a thread, the only kind history lists: a remote id arrives with the destination's
 * acknowledgement, a local one at the claim, before the thread exists, so it counts once bound or
 * finished. Counted states move only to counted ones. The terms are channel_child_work_launches'
 * own; INDEXED BY makes a mismatch fail instead of scanning every child record.
 */
const openableLaunch = (sql: SqlClient.SqlClient) =>
  sql`s.key >= 'child-work:' AND s.key < 'child-work;'
    AND json_extract(s.value_json, '$.surface') IN ('thread_launch', 'ssh_thread_launch')
    AND json_extract(s.value_json, '$.destination.threadId') IS NOT NULL
    AND (json_extract(s.value_json, '$.surface') = 'ssh_thread_launch'
      OR json_extract(s.value_json, '$.state') IN ('bound', 'completed', 'failed', 'cancelled'))`;

/** A task's newest openable launches, read from their index; one more tells whether there are more. */
export const launchesStatement = (
  sql: SqlClient.SqlClient,
  input: { readonly ownerId: string; readonly taskId: string; readonly limit: number },
) =>
  sql<{
    readonly key: string;
    readonly value_json: string;
    readonly title: string | null;
    readonly project_id: string | null;
    readonly work_kind: unknown;
  }>`SELECT s.key, s.value_json, p.title, p.project_id,
      json_extract(p.payload_json, '$.launchedBy.workKind') AS work_kind
    FROM channel_runtime_state s INDEXED BY channel_child_work_launches
    -- Only a local launch's thread is in this machine's projection.
    LEFT JOIN orchestration_v2_projection_threads p
      ON json_extract(s.value_json, '$.surface') = 'thread_launch'
      AND json_extract(s.value_json, '$.destination.host') IS NULL
      AND p.thread_id = json_extract(s.value_json, '$.destination.threadId')
    WHERE json_extract(s.value_json, '$.taskId') = ${input.taskId} AND ${openableLaunch(sql)}
      AND json_extract(s.value_json, '$.ownerId') = ${input.ownerId}
    ORDER BY json_extract(s.value_json, '$.createdAt') DESC, s.key DESC
    LIMIT ${input.limit}`;

/**
 * A bot's tasks by creation, newest first, one row per task examined; created_at and task_id never
 * change, so a task keeps its place between pages. task_json is set only for a task history lists:
 * a turn joins once a launch has a thread, and never leaves. The row value makes the cursor one
 * range on the index's four columns, so a page costs the same anywhere inside a tie.
 */
export const historyStatement = (
  sql: SqlClient.SqlClient,
  input: CursorScope & { readonly after: HistoryKey | undefined; readonly limit: number },
) => {
  const after =
    input.after === undefined
      ? sql``
      : sql`AND (t.created_at, t.task_id) < (${input.after.createdAt}, ${input.after.taskId})`;
  return sql<{
    readonly task_id: string;
    readonly created_at: string;
    readonly task_json: string | null;
  }>`SELECT t.task_id, t.created_at, CASE
      WHEN NOT EXISTS (SELECT 1 FROM channel_conversations c
        WHERE c.conversation_id = t.conversation_id AND c.owner_id = ${input.ownerId}
          AND c.kind = 'goat') THEN NULL
      WHEN COALESCE(json_extract(t.task_json, '$.kind'), 'work') != 'turn' THEN t.task_json
      WHEN EXISTS (SELECT 1 FROM channel_runtime_state s INDEXED BY channel_child_work_launches
        -- "+" drops task_id's TEXT affinity, which would keep SQLite from seeking the index.
        WHERE json_extract(s.value_json, '$.taskId') = +t.task_id AND ${openableLaunch(sql)})
        THEN t.task_json
    END AS task_json
    FROM channel_tasks t INDEXED BY channel_tasks_owner_bot_created
    WHERE t.owner_id = ${input.ownerId} AND t.bot_id = ${input.botId} ${after}
    ORDER BY t.created_at DESC, t.task_id DESC LIMIT ${input.limit}`;
};

export const readHistoryPage = Effect.fn("ChannelBotThreads.historyPage")(function* (
  sql: SqlClient.SqlClient,
  scope: CursorScope & { readonly cursor: string | undefined },
) {
  const after =
    scope.cursor === undefined ? undefined : yield* decodeHistoryCursor(scope, scope.cursor);
  const rows = yield* historyStatement(sql, {
    ...scope,
    after,
    limit: CHANNEL_BOT_THREADS_HISTORY_EXAMINED + 1,
  }).pipe(Effect.mapError(() => new ChannelGatewayError({ reason: "persistence_failed" })));
  // The page ends at its 50th listed task or its last examined one; the cursor names that task
  // either way, so a page can be short or empty and still go on.
  const listed: Array<{ readonly taskId: string; readonly json: string }> = [];
  let examined = 0;
  for (const row of rows.slice(0, CHANNEL_BOT_THREADS_HISTORY_EXAMINED)) {
    examined += 1;
    if (row.task_json === null) continue;
    listed.push({ taskId: row.task_id, json: row.task_json });
    if (listed.length === CHANNEL_BOT_THREADS_HISTORY_LIMIT) break;
  }
  const last = rows[examined - 1];
  const next =
    examined < rows.length && last !== undefined
      ? encodeHistoryCursor(scope, { createdAt: last.created_at, taskId: last.task_id })
      : undefined;
  const tasks: Array<ChannelTask> = [];
  // One unreadable task is left out and counted, so it marks the page partial instead of failing it.
  let skippedTasks = 0;
  for (const row of listed) {
    const task = yield* Effect.try(() => decodeTask(row.json)).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    if (task === undefined) skippedTasks += 1;
    else tasks.push(task);
  }
  // Ids GOAT generates are short digests; a cursor the decoder would refuse is never issued.
  const endedEarly =
    next !== undefined &&
    !(yield* decodeHistoryCursor(scope, next).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    ));
  if (endedEarly)
    yield* Effect.logWarning("GOAT Bot task history stops at a task it cannot name in a cursor", {
      taskId: last?.task_id,
    });
  return {
    tasks,
    skippedTasks,
    // A turn's answer is in the chat; it is listed by the threads it launched.
    threadsOnly: new Set<ChannelTaskId>(
      tasks.flatMap((task) => (task.kind === "turn" ? [task.taskId] : [])),
    ),
    ...(next === undefined || endedEarly ? {} : { nextCursor: next }),
    ...(endedEarly ? { endedEarly } : {}),
  };
});

/**
 * Up to 10 of each task's main messages since it went quiet, a min of the exact count, so any
 * comparison with 10 decides as the exact count would. The partial index holds only main
 * messages, so the work stops at the tenth; its terms must match the index's.
 */
export const quietMessagesStatement = (
  sql: SqlClient.SqlClient,
  input: { readonly ownerId: string; readonly inputs: string },
) =>
  sql<{ readonly task_id: string; readonly count: number }>`SELECT
    json_extract(target.value, '$.taskId') AS task_id, (SELECT count(*) FROM (
      SELECT 1 FROM channel_inbox i INDEXED BY channel_inbox_main_messages
      WHERE i.owner_id = ${input.ownerId}
        AND i.conversation_id = json_extract(target.value, '$.conversationId')
        AND i.accepted_at > json_extract(target.value, '$.quiet')
        AND i.state != 'rejected' AND json_extract(i.message_json, '$.intent') = 'message'
        AND json_extract(i.message_json, '$.taskId') IS NULL
        AND json_extract(i.message_json, '$.actor.senderThreadId') IS NULL
      LIMIT ${HISTORY_QUIET_MESSAGES_CAP})) AS count
    FROM json_each(${input.inputs}) target`;
