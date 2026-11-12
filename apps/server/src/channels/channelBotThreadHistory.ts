import {
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
  if (!cursor.startsWith("v1.")) return yield* invalid();
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
 * One page of a bot's tasks by creation, newest first. created_at and task_id never change after
 * insert, so a task keeps its place however its state changes between pages. A bot turn is listed
 * once it launched a thread, which it never undoes. The terms keep channel_tasks the outer loop on
 * channel_tasks_owner_bot_created, and the redundant "<=" makes the cursor a seek.
 */
export const historyStatement = (
  sql: SqlClient.SqlClient,
  input: CursorScope & { readonly after: HistoryKey | undefined; readonly limit: number },
) => {
  const after =
    input.after === undefined
      ? sql``
      : sql`AND t.created_at <= ${input.after.createdAt}
        AND (t.created_at < ${input.after.createdAt} OR t.task_id < ${input.after.taskId})`;
  return sql<{
    readonly task_json: string;
    readonly task_id: string;
    readonly created_at: string;
  }>`SELECT t.task_json, t.task_id, t.created_at FROM channel_tasks t
    WHERE t.owner_id = ${input.ownerId} AND t.bot_id = ${input.botId}
      AND EXISTS (SELECT 1 FROM channel_conversations c WHERE c.conversation_id = t.conversation_id
        AND c.owner_id = ${input.ownerId} AND c.kind = 'goat')
      AND (COALESCE(json_extract(t.task_json, '$.kind'), 'work') != 'turn' OR EXISTS (
        SELECT 1 FROM channel_runtime_state s
        WHERE s.key >= ('child-work:' || t.task_id || ':') AND s.key < ('child-work:' || t.task_id || ';')
          AND json_extract(s.value_json, '$.surface') IN ('thread_launch', 'ssh_thread_launch')))
      ${after}
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
    limit: CHANNEL_BOT_THREADS_HISTORY_LIMIT + 1,
  }).pipe(Effect.mapError(() => new ChannelGatewayError({ reason: "persistence_failed" })));
  const page = rows.slice(0, CHANNEL_BOT_THREADS_HISTORY_LIMIT);
  const tasks = yield* Effect.try(() => page.map((row) => decodeTask(row.task_json))).pipe(
    Effect.mapError(() => new ChannelGatewayError({ reason: "persistence_failed" })),
  );
  const last = page.at(-1);
  return {
    tasks,
    // A turn's answer is in the chat; it is listed by the threads it launched.
    threadsOnly: new Set<ChannelTaskId>(
      tasks.flatMap((task) => (task.kind === "turn" ? [task.taskId] : [])),
    ),
    ...(rows.length > page.length && last !== undefined
      ? {
          nextCursor: encodeHistoryCursor(scope, {
            createdAt: last.created_at,
            taskId: last.task_id,
          }),
        }
      : {}),
  };
});
