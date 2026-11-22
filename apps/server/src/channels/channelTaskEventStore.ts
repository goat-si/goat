import { ChannelTask, ChannelTaskEvent } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import { workerLaunchIdsFor } from "./channelIds.ts";
import type { ChannelTaskEventWrite } from "./ChannelLedger.ts";
import { ChannelLedgerError } from "./channelLedgerError.ts";
import {
  reconcileBoundBotHandoffAttention,
  recordBotAttention,
  taskEventCanCreateAttention,
} from "./channelBotAttention.ts";
import { newestAskAt } from "./channelWaitingTasks.ts";

const taskJson = Schema.fromJsonString(ChannelTask);
const decodeTask = Schema.decodeUnknownSync(taskJson);
export const encodeTask = Schema.encodeSync(taskJson);
export const encodeEvent = Schema.encodeSync(Schema.fromJsonString(ChannelTaskEvent));

export const makeTaskEventWriter = (sql: SqlClient.SqlClient) =>
  Effect.fn("ChannelLedger.writeTaskEvent")(function* (write: ChannelTaskEventWrite) {
    const { next, event } = write;
    const attentionSource = taskEventCanCreateAttention(event)
      ? (yield* sql<{ owner_id: string; bot_id: string; task_json: string }>`
              SELECT owner_id, bot_id, task_json FROM channel_tasks
              WHERE task_id = ${next.taskId} AND version = ${write.expectedVersion}
            `)[0]
      : undefined;
    const pendingAnswer =
      write.pendingAnswerMessageId === undefined
        ? sql`pending_answer_message_id`
        : sql`${write.pendingAnswerMessageId}`;
    const hold =
      write.completionHold === undefined ? sql`completion_hold` : sql`${write.completionHold}`;
    // A message may have moved updated_at past this write's clock; task activity never goes back.
    const activeAt = sql`CASE WHEN julianday(updated_at) > julianday(${next.updatedAt})
        THEN updated_at ELSE ${next.updatedAt} END`;
    const updated = yield* sql<{ readonly task_id: string }>`
        UPDATE channel_tasks SET
          status = ${next.status},
          version = ${next.version},
          generation = ${next.generation},
          worker_thread_id = ${next.worker?.threadId ?? null},
          task_json = json_set(${encodeTask(next)}, '$.updatedAt', ${activeAt}),
          newest_ask_at = ${newestAskAt(next)},
          updated_at = ${activeAt},
          pending_answer_message_id = ${pendingAnswer},
          completion_hold = ${hold}
        WHERE task_id = ${next.taskId} AND version = ${write.expectedVersion}
        RETURNING task_id
      `;
    if (updated.length === 0) {
      return yield* new ChannelLedgerError({
        reason: "version_conflict",
        detail: "Task " + next.taskId + " is not at version " + write.expectedVersion + ".",
      });
    }
    if (event.type === "task.dispatch.claimed" && event.payload.target.remote === undefined) {
      const worker = workerLaunchIdsFor(next.taskId, next.generation);
      yield* sql`INSERT INTO channel_worker_generations (worker_thread_id, task_id, generation)
          VALUES (${worker.threadId}, ${next.taskId}, ${next.generation})
          ON CONFLICT (task_id) DO UPDATE SET worker_thread_id = excluded.worker_thread_id,
            generation = excluded.generation`;
    }
    const inserted = yield* sql<{ readonly sequence: number }>`
        INSERT INTO channel_task_events (
          event_id, task_id, task_version, type, event_json, occurred_at,
          narration_state, forward_state
        ) VALUES (
          ${event.eventId}, ${event.taskId}, ${event.taskVersion}, ${event.type},
          ${encodeEvent(event)}, ${event.occurredAt},
          ${write.narrate === true ? "pending" : "none"},
          ${write.forward === true ? "pending" : "none"}
        )
        RETURNING sequence
      `;
    if (attentionSource !== undefined) {
      yield* recordBotAttention(sql, {
        ownerId: attentionSource.owner_id,
        botId: attentionSource.bot_id,
        before: decodeTask(attentionSource.task_json),
        next,
        event,
      });
    }
    if (event.type === "task.worker.bound") yield* reconcileBoundBotHandoffAttention(sql, next);
    return inserted[0]?.sequence ?? 0;
  });
