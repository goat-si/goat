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
 * A launch with a thread to open, the only kind history lists. Its destination is set when the
 * launch is claimed or bound and is replaced, never removed, so a record only ever enters this set.
 * The terms are channel_child_work_launches' own, which SQLite needs to use that index.
 */
const openableLaunch = (sql: SqlClient.SqlClient) =>
  sql`s.key >= 'child-work:' AND s.key < 'child-work;'
    AND json_extract(s.value_json, '$.surface') IN ('thread_launch', 'ssh_thread_launch')
    AND json_extract(s.value_json, '$.destination.threadId') IS NOT NULL`;

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
    FROM channel_runtime_state s
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
 * A bot's tasks by creation, newest first; created_at and task_id never change, so a task keeps its
 * place between pages. A turn joins once a launch has a thread to open, and never leaves. The terms
 * keep channel_tasks the outer loop on its index; the redundant "<=" makes the cursor a seek.
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
        WHERE json_extract(s.value_json, '$.taskId') = t.task_id AND ${openableLaunch(sql)}))
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
  const next =
    rows.length > page.length && last !== undefined
      ? encodeHistoryCursor(scope, { createdAt: last.created_at, taskId: last.task_id })
      : undefined;
  // Ids GOAT generates are short digests; a longer stored one cannot be named in a cursor.
  const endedEarly = next !== undefined && next.length > CHANNEL_BOT_THREADS_CURSOR_MAX_LENGTH;
  if (endedEarly)
    yield* Effect.logWarning("GOAT Bot task history stops at a task id too long for a cursor", {
      taskId: last?.task_id,
    });
  return {
    tasks,
    // A turn's answer is in the chat; it is listed by the threads it launched.
    threadsOnly: new Set<ChannelTaskId>(
      tasks.flatMap((task) => (task.kind === "turn" ? [task.taskId] : [])),
    ),
    ...(next === undefined || endedEarly ? {} : { nextCursor: next }),
    ...(endedEarly ? { endedEarly } : {}),
  };
});
