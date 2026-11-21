import {
  CHANNEL_BOT_TASK_ACTIVITY_LIMIT,
  ChannelGatewayError,
  ChannelTaskEvent,
  isChannelChildWorkTerminal,
  isGoatBotSessionThreadId,
  type ChannelBotTaskActivity,
  type ChannelBotTaskActivityEntry,
  type ChannelChildWork,
  type ChannelTask,
  type ChannelTaskEventType,
  type ChannelTaskStatus,
  type EnvironmentId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

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

export const readBotTaskActivity = Effect.fn("ChannelBotThreads.readActivity")(
  function* (
    sql: SqlClient.SqlClient,
    input: {
      readonly task: ChannelTask;
      readonly environmentId?: EnvironmentId;
      readonly children: ReadonlyArray<ChannelChildWork>;
      readonly links: ReadonlyArray<{
        readonly repository: string;
        readonly number: number;
        readonly linkedAt: string;
      }>;
      readonly partial: boolean;
    },
  ) {
    const { task, children, links } = input;
    const rows = yield* sql<{ readonly event_json: string; readonly worker_json: string | null }>`
    SELECT e.event_json, CASE WHEN e.type IN ('task.completed', 'task.failed', 'task.cancelled', 'task.moved') THEN (
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
    ORDER BY e.task_version DESC LIMIT ${limit}
  `;
    const [coverage] = yield* sql<{ readonly updated_at: string }>`
    SELECT updated_at FROM channel_runtime_state WHERE key = 'bot-task-activity-since'
  `;
    // Worker observations store the current PR snapshot. Use its latest recorded observation
    // only where no local thread supplies the actual link time.
    const observed = task.observed?.pullRequests ?? [];
    const [lastObservation] =
      observed.length === 0
        ? []
        : yield* sql<{ readonly occurred_at: string }>`
    SELECT occurred_at FROM channel_task_events WHERE task_id = ${task.taskId}
      AND type = 'task.worker.observed'
      AND json_array_length(event_json, '$.payload.observed.pullRequests') > 0
    ORDER BY task_version DESC LIMIT 1
  `;
    const entries: ChannelBotTaskActivityEntry[] = [];
    let incomplete = input.partial;
    for (const row of rows) {
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
        case "task.view.snoozed":
          entries.push({ ...meta, type: "snoozed", until: event.payload.until });
          break;
        case "task.view.unsnoozed":
          entries.push({ ...meta, type: "unsnoozed" });
          break;
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
        environmentId = host === undefined
          ? (input.environmentId ?? task.worker?.environmentId)
          : undefined,
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
    for (const { repository, number, linkedAt } of [
      ...links.toSorted((a, b) => a.linkedAt.localeCompare(b.linkedAt)),
      ...observed.map((pr) => ({
        ...pr,
        linkedAt: lastObservation?.occurred_at ?? task.updatedAt,
      })),
    ]) {
      const key = JSON.stringify([repository, number]);
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
