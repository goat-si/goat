import type { ChannelInputId, ChannelTask, MessageId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import { ChannelLedgerError } from "./channelLedgerError.ts";

export function channelMessageMemory(sql: SqlClient.SqlClient) {
  const pausedInput = (origin: ChannelInputId, sender?: ChannelInputId) =>
    sql`SELECT 1 FROM channel_inbox WHERE input_id IN (${origin}, ${sender ?? origin})
      AND conversation_memory_enabled = 0 LIMIT 1`;
  const failed = (cause: unknown) =>
    new ChannelLedgerError({
      reason: "persistence",
      detail: "Could not resolve the channel input's memory policy.",
      cause,
    });
  return {
    inputMemoryPaused: (origin: ChannelInputId, sender?: ChannelInputId) =>
      pausedInput(origin, sender).pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.mapError(failed),
      ),
    // Titles and results can repeat the original request or a later follow-up in a new session.
    tasksForSessionHistory: (tasks: ReadonlyArray<ChannelTask>, includePaused = false) =>
      includePaused || tasks.length === 0
        ? Effect.succeed(tasks)
        : sql<{ task_id: ChannelTask["taskId"] }>`SELECT task_id FROM channel_tasks AS t
        WHERE EXISTS (SELECT 1 FROM conversation_memory_policy WHERE enabled=0)
          AND ${sql.in(
            "task_id",
            tasks.map((task) => task.taskId),
          )}
          AND (EXISTS (SELECT 1 FROM channel_inbox WHERE input_id=json_extract(t.task_json,'$.originInputId')
             AND conversation_memory_enabled=0)
          OR EXISTS (SELECT 1 FROM channel_task_events AS e JOIN channel_inbox AS i
             ON i.input_id=coalesce(json_extract(e.event_json,'$.payload.sender.inputId'),
               CASE WHEN json_extract(e.event_json,'$.actor')='user' THEN json_extract(e.event_json,'$.payload.inputId') END)
             WHERE e.task_id=t.task_id AND e.type IN ('task.followup.received','task.question.answered') AND i.conversation_memory_enabled=0))`.pipe(
            Effect.map((rows) => {
              const excluded = new Set(rows.map((row) => row.task_id));
              return tasks.filter((task) => !excluded.has(task.taskId));
            }),
            Effect.mapError(failed),
          ),
    threadsForSessionHistory: <T extends { readonly id: ThreadId }>(
      threads: ReadonlyArray<T>,
      includePaused: boolean,
    ) =>
      includePaused || threads.length === 0
        ? Effect.succeed(threads)
        : sql<{
            id: ThreadId;
          }>`SELECT value AS id FROM json_each(${JSON.stringify(threads.map((thread) => thread.id))})
            WHERE EXISTS (SELECT 1 FROM conversation_memory_excluded_messages WHERE thread_id=value)`.pipe(
            Effect.map((rows) => {
              const excluded = new Set(rows.map((row) => row.id));
              return threads.filter((thread) => !excluded.has(thread.id));
            }),
            Effect.mapError(failed),
          ),
    // The deterministic IDs also cover retries. Record consent before the orchestrator can dispatch.
    preserveInputMemoryPause: (
      thread: ThreadId,
      message: MessageId,
      origin: ChannelInputId,
      sender?: ChannelInputId,
    ) =>
      sql`INSERT OR IGNORE INTO conversation_memory_excluded_messages (thread_id, message_id)
        SELECT ${thread}, ${message} WHERE EXISTS (${pausedInput(origin, sender)})`.pipe(
        Effect.asVoid,
        Effect.mapError(failed),
      ),
  };
}
