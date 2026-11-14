import {
  ChannelGatewayError,
  ChannelTask,
  ChannelTaskId,
  type ChannelSearchBotTasksInput,
} from "@goat/contracts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- cursor scope tags are synchronous.
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

const invalid = () => new ChannelGatewayError({ reason: "invalid_input" });
const failed = () => new ChannelGatewayError({ reason: "persistence_failed" });
const decodeTask = Schema.decodeUnknownSync(Schema.fromJsonString(ChannelTask));
const tag = (value: string) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
type Key = { readonly createdAt: string; readonly taskId: string };
type Scope = {
  readonly ownerId: string;
  readonly botId: string;
  readonly query: string;
  readonly limit?: number;
};

const encodeCursor = (scope: Scope, key: Key) =>
  "v1." +
  Buffer.from(
    JSON.stringify([
      tag(scope.ownerId),
      tag(scope.botId),
      tag(scope.query),
      key.createdAt,
      key.taskId,
    ]),
  ).toString("base64url");

const decodeCursor = (scope: Scope, cursor: string) => {
  if (cursor.length > 512 || !cursor.startsWith("v1.")) throw invalid();
  let body: unknown;
  try {
    body = JSON.parse(Buffer.from(cursor.slice(3), "base64url").toString("utf8"));
  } catch {
    throw invalid();
  }
  if (!Array.isArray(body) || body.length !== 5 || body.some((part) => typeof part !== "string"))
    throw invalid();
  const [owner, bot, query, createdAt, taskId] = body as string[];
  if (
    owner !== tag(scope.ownerId) ||
    bot !== tag(scope.botId) ||
    query !== tag(scope.query) ||
    !createdAt ||
    createdAt.length > 64 ||
    !taskId ||
    taskId.length > 200
  )
    throw invalid();
  const key = { createdAt, taskId };
  if (encodeCursor(scope, key) !== cursor) throw invalid();
  return key;
};

export const cutBotWorkTitle = (title: string) => {
  let prefix = "";
  let count = 0;
  for (const point of title) {
    if (count === 200) return { title: prefix.trim(), titleTruncated: true as const };
    prefix += point;
    count++;
  }
  return { title };
};

export const searchStatement = (sql: SqlClient.SqlClient, scope: Scope, after: Key | undefined) => {
  const boundary =
    after === undefined
      ? sql``
      : sql`AND (created_at, task_id) < (${after.createdAt}, ${after.taskId})`;
  const escape = String.fromCharCode(92);
  const escaped = scope.query.replace(/[\\%_]/g, (ch) => escape + ch);
  const pattern = "%" + escaped + "%";
  // A stored title is matched up to its first NUL character.
  // ORDER BY evaluates predicates for at most 500 materialized candidates even when the result limit is smaller.
  return sql<{
    readonly partial: number;
    readonly last_created_at: string | null;
    readonly last_task_id: string | null;
    readonly more: number;
    readonly task_id: string | null;
    readonly conversation_id: string | null;
    readonly created_at: string | null;
    readonly task_json: string | null;
  }>`
    WITH candidates AS MATERIALIZED (
      SELECT task_id, created_at, conversation_id FROM channel_tasks INDEXED BY channel_tasks_owner_bot_created
      WHERE owner_id = ${scope.ownerId} AND bot_id = ${scope.botId} ${boundary}
      ORDER BY created_at DESC, task_id DESC LIMIT 501
    ), processed AS MATERIALIZED (SELECT * FROM candidates LIMIT 500),
    evaluated AS MATERIALIZED (
      SELECT p.task_id, p.created_at, p.conversation_id,
        CASE WHEN octet_length(t.task_json) > 262144 THEN 0
          WHEN NOT json_valid(t.task_json) THEN 0
          WHEN json_type(t.task_json, '$.title') IS NOT 'text' THEN 0
          WHEN length(trim(json_extract(t.task_json, '$.title'))) = 0 THEN 0
          WHEN json_type(t.task_json, '$.taskId') IS NOT 'text' THEN 0
          WHEN json_type(t.task_json, '$.conversationId') IS NOT 'text' THEN 0
          WHEN json_extract(t.task_json, '$.taskId') != p.task_id THEN 0
          WHEN json_extract(t.task_json, '$.conversationId') != p.conversation_id THEN 0
          ELSE 1 END AS valid,
        CASE WHEN octet_length(t.task_json) > 262144 THEN 0
          WHEN NOT json_valid(t.task_json) THEN 0
          WHEN json_type(t.task_json, '$.title') IS NOT 'text' THEN 0
          WHEN length(trim(json_extract(t.task_json, '$.title'))) = 0 THEN 0
          WHEN json_type(t.task_json, '$.taskId') IS NOT 'text' THEN 0
          WHEN json_type(t.task_json, '$.conversationId') IS NOT 'text' THEN 0
          WHEN json_extract(t.task_json, '$.taskId') != p.task_id THEN 0
          WHEN json_extract(t.task_json, '$.conversationId') != p.conversation_id THEN 0
          WHEN NOT EXISTS (SELECT 1 FROM channel_conversations c WHERE c.conversation_id = p.conversation_id AND c.owner_id = ${scope.ownerId} AND c.kind = 'goat') THEN 0
          WHEN COALESCE(json_extract(t.task_json, '$.kind'), 'work') = 'turn' THEN 0
          WHEN json_extract(t.task_json, '$.title') LIKE ${pattern} ESCAPE ${escape} THEN 1
          ELSE 0 END AS matches
      FROM processed p JOIN channel_tasks t ON t.task_id = p.task_id
    ), ranked AS MATERIALIZED (
      SELECT *, COALESCE(sum(matches) OVER (ORDER BY created_at DESC, task_id DESC
        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS previous_matches
      FROM evaluated
    ), page AS MATERIALIZED (
      SELECT * FROM ranked WHERE previous_matches < ${scope.limit ?? 20}
      ORDER BY created_at DESC, task_id DESC
    ), metadata AS MATERIALIZED (
      SELECT COALESCE(max(CASE WHEN valid = 0 THEN 1 ELSE 0 END), 0) AS partial,
        (SELECT created_at FROM page ORDER BY created_at ASC, task_id ASC LIMIT 1) AS last_created_at,
        (SELECT task_id FROM page ORDER BY created_at ASC, task_id ASC LIMIT 1) AS last_task_id,
        (SELECT count(*) FROM candidates) > (SELECT count(*) FROM page) AS more
      FROM page
    )
    SELECT metadata.*, matched.task_id, matched.conversation_id, matched.created_at, t.task_json
    FROM metadata LEFT JOIN page matched ON matched.matches = 1
    LEFT JOIN channel_tasks t ON t.task_id = matched.task_id
    ORDER BY matched.created_at DESC, matched.task_id DESC`;
};

export const searchBotTasks = Effect.fn("ChannelBotThreads.searchBotTasks")(function* (
  sql: SqlClient.SqlClient,
  ownerId: string,
  input: ChannelSearchBotTasksInput,
) {
  const query = input.query.trim();
  if (!query || query.includes("\0") || Buffer.byteLength(query, "utf8") > 256)
    return yield* invalid();
  const scope = { ownerId, botId: input.botId, query, limit: input.limit ?? 20 };
  const cursorInput = input.cursor;
  const after =
    cursorInput === undefined
      ? undefined
      : yield* Effect.try({ try: () => decodeCursor(scope, cursorInput), catch: invalid });
  const rows = yield* searchStatement(sql, scope, after).pipe(Effect.mapError(failed));
  const row = rows[0];
  if (row === undefined) return yield* failed();
  const tasks: Array<{
    taskId: ChannelTaskId;
    title: string;
    createdAt: string;
    titleTruncated?: boolean;
  }> = [];
  let partial = row.partial === 1;
  for (const item of rows) {
    if (item.task_id === null) continue;
    if (item.task_json === null || item.conversation_id === null || item.created_at === null)
      return yield* failed();
    const json = item.task_json;
    const task = yield* Effect.try(() => decodeTask(json)).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    if (
      task === undefined ||
      task.taskId !== item.task_id ||
      task.conversationId !== item.conversation_id
    ) {
      partial = true;
      continue;
    }
    tasks.push({
      taskId: ChannelTaskId.make(item.task_id),
      ...cutBotWorkTitle(task.title),
      createdAt: item.created_at,
    });
  }
  const more = row.more === 1;
  const key =
    row.last_created_at === null || row.last_task_id === null
      ? undefined
      : { createdAt: row.last_created_at, taskId: row.last_task_id };
  const cursor =
    more &&
    key !== undefined &&
    key.createdAt.length > 0 &&
    key.createdAt.length <= 64 &&
    key.taskId.length > 0 &&
    key.taskId.length <= 200
      ? encodeCursor(scope, key)
      : undefined;
  const encodable = cursor !== undefined && cursor.length <= 512;
  return {
    tasks,
    ...(partial ? { partial: true } : {}),
    ...(more && encodable ? { nextCursor: cursor } : {}),
    ...(more && !encodable ? { endedEarly: true } : {}),
  };
});
