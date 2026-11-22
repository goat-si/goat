import { CHANNEL_BOT_THREADS_SNOOZED_LIMIT } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect has no incremental digest.
import * as NodeCrypto from "node:crypto";
import { botWorkConversationFilter, botWorkTaskFilter } from "./channelBotThreadHistory.ts";
import { taskViewKeyPrefix } from "./channelTaskViews.ts";

interface HomeScope {
  readonly ownerId: string;
  readonly botId: string;
  readonly now: string;
}

export interface HomeTaskRow {
  readonly task_id: string;
  readonly task_json: string;
  readonly status_version: number;
}

const ownerViews = (sql: SqlClient.SqlClient, ownerId: string) => {
  const prefix = taskViewKeyPrefix(ownerId);
  return sql`v.key >= 'task-view:' AND v.key < 'task-view;'
    AND v.key >= ${prefix} AND v.key < ${prefix.slice(0, -1) + ";"}`;
};

const viewTaskId = (sql: SqlClient.SqlClient) =>
  sql`CASE WHEN json_valid(v.value_json) THEN json_extract(v.value_json, '$.taskId') END`;

const activeSnooze = (sql: SqlClient.SqlClient, now: string) =>
  sql`json_extract(v.value_json, '$.snoozedUntil') > ${now}
    AND json_extract(v.value_json, '$.snoozedStatusVersion') = t.status_version`;

export const unreadableHomeTaskView = (sql: SqlClient.SqlClient, ownerId: string) =>
  sql`SELECT 1 FROM channel_runtime_state v INDEXED BY channel_task_views_by_task
    WHERE ${ownerViews(sql, ownerId)} AND json_valid(v.value_json) = 0 LIMIT 1`;

export const recentHomeTaskRows = (
  sql: SqlClient.SqlClient,
  { ownerId, botId, now, cutoff }: HomeScope & { readonly cutoff: string },
) => sql<HomeTaskRow>`
  WITH recent AS (
    SELECT t.task_id, t.task_json, t.status_version, t.updated_at
    FROM channel_tasks t
    JOIN channel_conversations c ON c.conversation_id = t.conversation_id
    LEFT JOIN channel_runtime_state v ON v.key = (
      SELECT v.key FROM channel_runtime_state v INDEXED BY channel_task_views_by_task
      WHERE ${ownerViews(sql, ownerId)} AND json_valid(v.value_json) = 1
        AND ${viewTaskId(sql)} = t.task_id
      ORDER BY v.key LIMIT 1
    )
    WHERE t.owner_id = ${ownerId} AND t.bot_id = ${botId} AND c.owner_id = ${ownerId}
      AND ${botWorkConversationFilter(sql, botId)} AND NOT COALESCE((${activeSnooze(sql, now)}), 0)
      AND ((${botWorkTaskFilter(sql, botId)}
        AND (t.status NOT IN ('completed', 'failed', 'cancelled')
          OR COALESCE(json_extract(t.task_json, '$.completedAt'), t.updated_at) >= ${cutoff}
          OR json_type(v.value_json, '$.pinnedAt') = 'text'))
        OR (c.kind = 'goat' AND json_extract(t.task_json, '$.kind') = 'turn' AND EXISTS (
          SELECT 1 FROM channel_runtime_state s
          WHERE s.key >= ('child-work:' || t.task_id || ':') AND s.key < ('child-work:' || t.task_id || ';')
            AND json_extract(s.value_json, '$.generation') = t.generation
            AND json_extract(s.value_json, '$.state') IN ('launched', 'bound', 'unknown'))))
    ORDER BY COALESCE(json_type(v.value_json, '$.pinnedAt') = 'text', 0) DESC,
      t.updated_at DESC, t.task_id DESC LIMIT 100
  )
  SELECT task_id, task_json, status_version
  FROM recent ORDER BY updated_at DESC, task_id DESC
`;

export const snoozedHomeTaskRows = (
  sql: SqlClient.SqlClient,
  scope: HomeScope,
  after: { readonly createdAt: string; readonly taskId: string } | undefined,
) => sql<HomeTaskRow & { readonly until: string }>`
  SELECT t.task_id, t.task_json, t.status_version,
    json_extract(v.value_json, '$.snoozedUntil') AS until
  ${activeHomeSnoozeViews(sql, scope)}
    ${
      after === undefined
        ? sql``
        : sql`AND (json_extract(v.value_json, '$.snoozedUntil'), t.task_id) > (${after.createdAt}, ${after.taskId})`
    }
  ORDER BY until, t.task_id LIMIT ${CHANNEL_BOT_THREADS_SNOOZED_LIMIT + 1}
`;

// The CASE lets the revision scan seek by view key instead of scanning the JSON-validity index.
const activeHomeSnoozeViews = (sql: SqlClient.SqlClient, { ownerId, botId, now }: HomeScope) =>
  sql`FROM channel_runtime_state v
    JOIN channel_tasks t ON t.task_id = ${viewTaskId(sql)}
    JOIN channel_conversations c ON c.conversation_id = t.conversation_id
    WHERE ${ownerViews(sql, ownerId)}
      AND t.owner_id = ${ownerId} AND t.bot_id = ${botId}
      AND c.owner_id = ${ownerId} AND ${botWorkConversationFilter(sql, botId)}
      AND CASE WHEN json_valid(v.value_json) THEN (${activeSnooze(sql, now)}) END`;

// Home hashes only IDs and deadlines in bounded batches within its existing reader snapshot.
export const readHomeSnoozedRevision = Effect.fn("ChannelBotThreads.snoozedRevision")(function* (
  sql: SqlClient.SqlClient,
  scope: HomeScope,
) {
  const hash = NodeCrypto.createHash("sha256");
  const batchSize = 256;
  let after = taskViewKeyPrefix(scope.ownerId);
  while (true) {
    const rows = yield* sql<{ readonly key: string; readonly revision_row: string }>`
      SELECT v.key, json_array(v.key, json_extract(v.value_json, '$.snoozedUntil')) AS revision_row
      ${activeHomeSnoozeViews(sql, scope)} AND v.key > ${after}
      ORDER BY v.key LIMIT ${batchSize}`;
    for (const { revision_row } of rows) hash.update(revision_row);
    const last = rows.at(-1);
    if (last === undefined || rows.length < batchSize) return hash.digest("hex");
    after = last.key;
  }
});
