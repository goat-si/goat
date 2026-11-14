/**
 * A task's message mark: its updated_at when GOAT last queued it a bot-thread message. Written
 * with the outbox row, so a queued message always has its mark and a failed mark queues nothing.
 * @module channelTaskMessageMarks
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

import type { ChannelOutboxInsert } from "./ChannelLedger.ts";

export const messageMarkKey = (ownerId: string, taskId: string) =>
  "task-message-mark:" + encodeURIComponent(ownerId) + ":" + encodeURIComponent(taskId);

const MarkJson = Schema.fromJsonString(Schema.Struct({ at: Schema.String }));
const decodeMark = Schema.decodeUnknownSync(MarkJson);
const encodeMark = Schema.encodeSync(MarkJson);

/** The stored mark, or undefined when it cannot be read. */
export const readMessageMark = (json: string): { readonly at: string } | undefined => {
  try {
    const mark = decodeMark(json);
    return Number.isFinite(Date.parse(mark.at)) ? mark : undefined;
  } catch {
    return undefined;
  }
};

/** The task a post shows to the person as a GOAT assistant message, if any. */
const markedTask = (delivery: ChannelOutboxInsert) => {
  const message = delivery.message;
  if ((delivery.operation ?? "post") !== "post") return undefined;
  if (message.destination.kind !== "goat" || message.kind === "task_chip") return undefined;
  if (message.personAnswer !== undefined) return undefined;
  return message.taskId;
};

/** Raises the mark for a row just inserted; runs inside that insert's transaction. */
export const raiseMessageMark = Effect.fn("channelTaskMessageMarks.raise")(function* (
  sql: SqlClient.SqlClient,
  delivery: ChannelOutboxInsert,
  now: string,
) {
  const taskId = markedTask(delivery);
  if (taskId === undefined) return;
  const [task] = yield* sql<{
    readonly owner_id: string;
    readonly updated_at: string;
  }>`SELECT owner_id, updated_at FROM channel_tasks WHERE task_id = ${taskId}`;
  if (task === undefined) return;
  const key = messageMarkKey(task.owner_id, taskId);
  const [stored] = yield* sql<{
    readonly value_json: string;
  }>`SELECT value_json FROM channel_runtime_state WHERE key = ${key}`;
  const current = stored === undefined ? undefined : readMessageMark(stored.value_json);
  if (stored !== undefined && current === undefined)
    yield* Effect.logWarning("channel task message mark unreadable; replacing it", { taskId });
  if (current !== undefined && Date.parse(current.at) >= Date.parse(task.updated_at)) return;
  yield* sql`INSERT INTO channel_runtime_state (key, value_json, updated_at)
    VALUES (${key}, ${encodeMark({ at: task.updated_at })}, ${now})
    ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`;
});

/**
 * Unread for a task row. With a mark, a message newer than the read time; capped by updatedAt so
 * acknowledging the row's lastActivityAt always clears it. Without one, the earlier rule.
 */
export const taskRowUnread = (
  updatedAt: string,
  readThrough: string | null,
  mark: { readonly at: string } | undefined,
) => {
  if (readThrough === null) return true;
  const activity =
    mark === undefined
      ? Date.parse(updatedAt)
      : Math.min(Date.parse(mark.at), Date.parse(updatedAt));
  return activity > Date.parse(readThrough);
};
