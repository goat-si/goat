import {
  CHANNEL_BOT_TASK_ACTIVITY_LIMIT,
  ChannelGatewayError,
  ChannelTaskEvent,
  GOAT_BOT_SESSION_THREAD_PREFIX,
  IsoDateTime,
  PositiveInt,
  TrimmedNonEmptyString,
  ChannelChildWork,
  type ChannelTaskId,
  isChannelChildWorkTerminal,
  isGoatBotSessionThreadId,
  type ChannelBotTaskActivity,
  ChannelBotTaskActivityEntry,
  type ChannelTask,
  type ChannelTaskEventType,
  type ChannelTaskStatus,
  type EnvironmentId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import type * as SqlClient from "effect/sql/SqlClient";

import { launchesStatement, openableLaunch } from "./channelBotThreadHistory.ts";
import type { ChannelLedgerError } from "./channelLedgerError.ts";

const decodeChild = Schema.decodeUnknownOption(Schema.fromJsonString(ChannelChildWork));
const decodeActivity = Schema.decodeUnknownOption(
  Schema.fromJsonString(ChannelBotTaskActivityEntry),
);
const decodeLink = Schema.decodeUnknownOption(
  Schema.Struct({
    repository: TrimmedNonEmptyString,
    number: PositiveInt,
    linkedAt: IsoDateTime,
  }),
);
const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(ChannelTaskEvent));
const actorOf = { agent: "bot", user: "person", system: "goat" } as const;
const limit = CHANNEL_BOT_TASK_ACTIVITY_LIMIT;
const legacyStatuses: Partial<Record<ChannelTaskEventType, ChannelTaskStatus>> = {
  "task.dispatch.claimed": "dispatching",
  "task.worker.bound": "running",
  "task.completed": "completed",
  "task.failed": "failed",
  "task.cancelled": "cancelled",
  "task.moved": "received",
  "task.retry.requested": "received",
};

/** Bound the PR snapshot sources before expanding their link arrays. */
const readLaunchLinks = (
  sql: SqlClient.SqlClient,
  input: {
    readonly task: ChannelTask;
    readonly ownerId: string;
    readonly environmentId: EnvironmentId;
  },
) => {
  const { task, ownerId, environmentId } = input;
  const current = task.worker;
  const localThread =
    current === undefined ||
    current.host !== undefined ||
    isGoatBotSessionThreadId(current.threadId)
      ? null
      : current.threadId;
  return sql`
    WITH launches AS NOT MATERIALIZED (
      SELECT json_extract(s.value_json, '$.surface') AS surface,
        json_extract(s.value_json, '$.destination.threadId') AS thread_id,
        json_extract(s.value_json, '$.destination.host') AS host,
        json_extract(s.value_json, '$.destination.correlationId') AS correlation_id,
        json_extract(s.value_json, '$.callerThreadId') AS caller_id
      FROM channel_runtime_state s INDEXED BY channel_child_work_launches
      WHERE json_extract(s.value_json, '$.taskId') = ${task.taskId} AND ${openableLaunch(sql)}
        AND json_extract(s.value_json, '$.ownerId') = ${ownerId}
    ), bindings AS (
      SELECT json_extract(event_json, '$.payload.worker.threadId') AS thread_id
      FROM channel_task_events
      WHERE task_id = ${task.taskId} AND type = 'task.worker.bound' AND json_valid(event_json)
        AND json_extract(event_json, '$.payload.worker.environmentId') = ${environmentId}
        AND json_extract(event_json, '$.payload.worker.host') IS NULL
      ORDER BY task_version DESC LIMIT ${limit}
    ), recent_local AS (
      SELECT p.thread_id
      FROM launches l JOIN orchestration_v2_projection_threads p ON p.thread_id = l.thread_id
      WHERE l.surface = 'thread_launch' AND l.host IS NULL
      ORDER BY p.updated_at DESC, p.thread_id LIMIT ${limit}
    ), local_threads AS (
      SELECT thread_id FROM recent_local
      UNION SELECT thread_id FROM bindings
      UNION SELECT ${localThread}
    ), local_snapshots AS (
      SELECT p.payload_json AS snapshot
      FROM local_threads t JOIN orchestration_v2_projection_threads p ON p.thread_id = t.thread_id
      WHERE t.thread_id NOT LIKE ${GOAT_BOT_SESSION_THREAD_PREFIX + "%"}
      ORDER BY p.updated_at DESC, p.thread_id LIMIT ${limit}
    ), remote_snapshots AS (
      SELECT d.observation AS snapshot
      FROM launches l JOIN remote_dispatches d ON d.correlation_id = l.correlation_id
        AND d.origin_thread_id = l.caller_id AND d.host = l.host AND d.remote_thread_id = l.thread_id
      WHERE l.surface = 'ssh_thread_launch' AND d.reports_supported != 0 AND d.observation IS NOT NULL
      ORDER BY d.updated_at DESC, d.correlation_id LIMIT ${limit}
    ), links AS (
      SELECT CASE WHEN link.type = 'object' THEN link.value END AS value
      FROM (SELECT snapshot FROM local_snapshots UNION ALL SELECT snapshot FROM remote_snapshots) s
      JOIN json_each(CASE WHEN json_valid(s.snapshot) THEN CASE
        WHEN json_type(s.snapshot, '$.pullRequests') = 'array'
        THEN json_extract(s.snapshot, '$.pullRequests') END END) link
      WHERE link.type = 'object'
    ), facts AS (
      SELECT json_extract(value, '$.repository') AS repository,
        json_extract(value, '$.number') AS number, json_extract(value, '$.linkedAt') AS at
      FROM links WHERE COALESCE(json_extract(value, '$.source'), '') != 'stack-dismissed'
    )
    SELECT repository, number, MIN(at) AS linkedAt
    FROM facts
    WHERE typeof(repository) = 'text' AND typeof(number) = 'integer' AND number > 0 AND at IS NOT NULL
    GROUP BY repository, number
    ORDER BY linkedAt DESC, repository, number LIMIT ${limit}
  `.pipe(
    Effect.map((rows) =>
      rows.flatMap((row) => {
        const link = decodeLink(row);
        return Option.isSome(link) ? [link.value] : [];
      }),
    ),
  );
};

const readBotTaskActivity = Effect.fn("ChannelLedger.readTaskActivity")(
  function* (
    sql: SqlClient.SqlClient,
    input: {
      readonly task: ChannelTask;
      readonly ownerId: string;
      readonly environmentId: EnvironmentId;
    },
  ) {
    const { task } = input;
    const launchInput = { taskId: task.taskId, ownerId: input.ownerId, limit: limit + 1 };
    const launches = yield* launchesStatement(sql, launchInput);
    const finishes =
      launches.length <= limit
        ? []
        : yield* launchesStatement(sql, { ...launchInput, finished: true });
    const launchRows = [
      ...new Map(
        [...launches.slice(0, limit), ...finishes.slice(0, limit)].map((row) => [row.key, row]),
      ).values(),
    ];
    const children = launchRows.flatMap((row) => {
      const child = decodeChild(row.value_json);
      return Option.isSome(child) ? [child.value] : [];
    });
    const links = yield* readLaunchLinks(sql, input);
    const rows = yield* sql<{
      readonly event_json: string;
      readonly type: string;
      readonly worker_json: string | null;
    }>`
    SELECT e.type, e.event_json, CASE WHEN e.type IN ('task.completed', 'task.failed', 'task.cancelled', 'task.moved') THEN (
      SELECT w.event_json FROM channel_task_events w
      WHERE w.task_id = e.task_id AND w.task_version < e.task_version AND w.type = 'task.worker.bound'
        AND NOT EXISTS (
          SELECT 1 FROM channel_task_events b WHERE b.task_id = e.task_id
            AND b.task_version > w.task_version AND b.task_version < e.task_version
            AND b.type IN ('task.moved', 'task.retry.requested')
        )
      ORDER BY w.task_version DESC LIMIT 1
    ) END AS worker_json
    FROM channel_task_events e
    WHERE e.task_id = ${task.taskId} AND e.type IN (
      'task.created', 'task.dispatch.claimed', 'task.worker.bound', 'task.question.opened',
      'task.question.answered', 'task.completed', 'task.failed', 'task.cancelled',
      'task.moved', 'task.retry.requested', 'task.view.snoozed', 'task.view.unsnoozed'
    )
    ORDER BY e.occurred_at DESC, e.sequence DESC LIMIT ${limit}
  `;
    const [coverage] = yield* sql<{ readonly updated_at: string }>`
    SELECT updated_at FROM channel_runtime_state WHERE key = 'bot-task-activity-since'
  `;
    const observed = (task.observed?.pullRequests ?? []).flatMap((pr) =>
      pr.linkedAt === undefined
        ? []
        : [{ repository: pr.repository, number: pr.number, linkedAt: pr.linkedAt }],
    );
    const entries: ChannelBotTaskActivityEntry[] = [];
    let incomplete = launches.length > limit || children.length < launchRows.length;
    for (const row of rows) {
      if (row.type === "task.view.snoozed" || row.type === "task.view.unsnoozed") {
        const entry = decodeActivity(row.event_json);
        if (Option.isSome(entry)) entries.push(entry.value);
        else incomplete = true;
        continue;
      }
      const decoded = yield* Effect.try(() => ({
        event: decodeEvent(row.event_json),
        bound: row.worker_json === null ? undefined : decodeEvent(row.worker_json),
      })).pipe(Effect.orElseSucceed(() => undefined));
      if (decoded === undefined) {
        incomplete = true;
        continue;
      }
      const { event, bound } = decoded;
      const meta = { at: event.occurredAt, actor: actorOf[event.actor], id: event.eventId };
      switch (event.type) {
        case "task.created":
          entries.push({ ...meta, type: "created" });
          break;
        case "task.worker.bound": {
          const { environmentId, threadId } = event.payload.worker;
          if (!isGoatBotSessionThreadId(threadId))
            entries.push({ ...meta, type: "worker_started", environmentId, threadId });
          break;
        }
        case "task.question.opened":
          entries.push({ ...meta, type: "asked", requestId: event.payload.question.questionId });
          break;
        case "task.question.answered":
          entries.push({ ...meta, type: "answered", requestId: event.payload.questionId });
          break;
        default:
          break;
      }
      const status =
        event.statusAfter === undefined
          ? legacyStatuses[event.type]
          : (event.statusAfter ?? undefined);
      if (status !== undefined)
        entries.push({ ...meta, id: event.eventId + ":status", type: "status", status });
      if (bound?.type === "task.worker.bound") {
        const { environmentId, threadId } = bound.payload.worker;
        if (!isGoatBotSessionThreadId(threadId))
          entries.push({
            ...meta,
            id: event.eventId + ":finished",
            type: "worker_finished",
            environmentId,
            threadId,
          });
      }
    }
    for (const child of children) {
      const {
        threadId,
        host,
        environmentId = host === undefined ? input.environmentId : undefined,
      } = child.destination ?? {};
      if (
        threadId === undefined ||
        environmentId === undefined ||
        child.state === "reserved" ||
        child.state === "released"
      )
        continue;
      entries.push({
        id: "launch:" + child.childWorkId,
        type: "worker_started",
        actor: "bot",
        at: child.createdAt,
        environmentId,
        threadId,
      });
      if (isChannelChildWorkTerminal(child.state))
        entries.push({
          id: "launch-end:" + child.childWorkId,
          type: "worker_finished",
          actor: "goat",
          at: child.updatedAt,
          environmentId,
          threadId,
        });
    }
    const linked = new Set<string>();
    for (const { repository, number, linkedAt } of [...links, ...observed].toSorted((a, b) =>
      a.linkedAt.localeCompare(b.linkedAt),
    )) {
      const key = repository + "#" + number;
      if (linked.has(key)) continue;
      linked.add(key);
      entries.push({
        id: "pr:" + key,
        type: "pr_linked",
        actor: "goat",
        at: linkedAt,
        repo: repository,
        number,
      });
    }
    const latest = entries.toSorted((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
    const cutoff = coverage?.updated_at ?? task.createdAt;
    return {
      entries: latest,
      ...(incomplete || task.createdAt < cutoff ? { incompleteBefore: cutoff } : {}),
    } satisfies typeof ChannelBotTaskActivity.Type;
  },
  Effect.mapError(() => new ChannelGatewayError({ reason: "persistence_failed" })),
);

export function makeTaskHistoryReads(
  sql: SqlClient.SqlClient,
  toLedgerError: (detail: string) => (cause: unknown) => ChannelLedgerError,
) {
  return {
    /** Most recently frozen brief, including earlier generations for version allocation. */
    latestTaskBrief: Effect.fn("ChannelLedger.latestTaskBrief")(
      function* (taskId: ChannelTaskId) {
        const [row] = yield* sql<{ readonly event_json: string }>`
        SELECT event_json FROM channel_task_events
        WHERE task_id = ${taskId} AND type = 'task.brief.frozen'
        ORDER BY sequence DESC LIMIT 1
      `;
        const event = row === undefined ? undefined : decodeEvent(row.event_json);
        return event?.type === "task.brief.frozen" ? event.payload.brief : undefined;
      },
      Effect.mapError(toLedgerError("latestTaskBrief")),
    ),
    readTaskActivity: readBotTaskActivity.bind(undefined, sql),
  };
}
