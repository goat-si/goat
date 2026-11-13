import { ChannelGatewayError, ChannelTask, type ChannelSearchBotTasksInput } from "@goat/contracts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- cursor scope tags are synchronous.
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

const decodeTask = Schema.decodeUnknownSync(Schema.fromJsonString(ChannelTask));
const invalid = () => new ChannelGatewayError({ reason: "invalid_input" });
const failed = () => new ChannelGatewayError({ reason: "persistence_failed" });
const tag = (value: string) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
type Key = { readonly createdAt: string; readonly taskId: string };
type Scope = { readonly ownerId: string; readonly botId: string; readonly query: string };

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
  return sql<{
    readonly task_id: string;
    readonly created_at: string;
    readonly task_json: string;
    readonly matches: number;
    readonly more: number;
  }>`
    WITH candidates AS MATERIALIZED (
      SELECT task_id, created_at, task_json, conversation_id FROM channel_tasks INDEXED BY channel_tasks_owner_bot_created
      WHERE owner_id = ${scope.ownerId} AND bot_id = ${scope.botId} ${boundary}
      ORDER BY created_at DESC, task_id DESC LIMIT 501
    ), processed AS MATERIALIZED (SELECT * FROM candidates LIMIT 500)
    SELECT p.task_id, p.created_at, p.task_json,
      CASE WHEN json_valid(p.task_json) THEN
        CASE WHEN EXISTS (SELECT 1 FROM channel_conversations c WHERE c.conversation_id = p.conversation_id AND c.owner_id = ${scope.ownerId} AND c.kind = 'goat')
          AND COALESCE(json_extract(p.task_json, '$.kind'), 'work') != 'turn'
          AND json_extract(p.task_json, '$.title') LIKE ${pattern} ESCAPE ${escape} THEN 1 ELSE 0 END
        ELSE 0 END AS matches,
      (SELECT count(*) > 500 FROM candidates) AS more
    FROM processed p ORDER BY p.created_at DESC, p.task_id DESC`;
};

export const searchBotTasks = Effect.fn("ChannelBotThreads.searchBotTasks")(function* (
  sql: SqlClient.SqlClient,
  ownerId: string,
  input: ChannelSearchBotTasksInput,
) {
  const query = input.query.trim();
  if (!query || query.includes("\0") || Buffer.byteLength(query, "utf8") > 256)
    return yield* invalid();
  const scope = { ownerId, botId: input.botId, query };
  const cursorInput = input.cursor;
  const after =
    cursorInput === undefined
      ? undefined
      : yield* Effect.try({ try: () => decodeCursor(scope, cursorInput), catch: invalid });
  const rows = yield* searchStatement(sql, scope, after).pipe(Effect.mapError(failed));
  const tasks: Array<{
    taskId: ChannelTask["taskId"];
    title: string;
    titleTruncated?: boolean;
    createdAt: string;
  }> = [];
  let partial = false;
  let processed = 0;
  for (const row of rows) {
    processed++;
    const task = yield* Effect.try(() => decodeTask(row.task_json)).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    if (task === undefined) partial = true;
    else if (row.matches)
      tasks.push({
        taskId: task.taskId,
        ...cutBotWorkTitle(task.title),
        createdAt: row.created_at,
      });
    if (tasks.length === (input.limit ?? 20)) break;
  }
  const last = rows[processed - 1];
  const more = last !== undefined && (processed < rows.length || last.more === 1);
  const key = last === undefined ? undefined : { createdAt: last.created_at, taskId: last.task_id };
  const cursor =
    more && key !== undefined && key.createdAt.length <= 64 && key.taskId.length <= 200
      ? encodeCursor(scope, key)
      : undefined;
  const encodable =
    key !== undefined &&
    key.createdAt.length <= 64 &&
    key.taskId.length <= 200 &&
    cursor !== undefined &&
    cursor.length <= 512;
  return {
    tasks,
    ...(partial ? { partial: true } : {}),
    ...(more && encodable ? { nextCursor: cursor } : {}),
    ...(more && !encodable ? { endedEarly: true } : {}),
  };
});
