/**
 * A task's message mark: the task's updated_at when GOAT last recorded a bot-thread message for it.
 * Written in the transaction that settles the delivery, so a delivered message always has one.
 * @module channelTaskMessageMarks
 */
import type { ChannelOutboundMessage } from "@goat/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { taskViewKey } from "./channelTaskViews.ts";

export const messageMarkKey = (ownerId: string, taskId: string) =>
  "task-message-mark:" + encodeURIComponent(ownerId) + ":" + encodeURIComponent(taskId);

const MarkJson = Schema.fromJsonString(Schema.Struct({ at: Schema.String }));
const decodeMark = Schema.decodeUnknownSync(MarkJson);
const encodeMark = Schema.encodeSync(MarkJson);
const millis = (iso: string | null | undefined) => {
  const parsed = iso === null || iso === undefined ? NaN : Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : 0;
};

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
const markedTask = (message: ChannelOutboundMessage, operation: string) => {
  if (operation !== "post") return undefined;
  if (message.destination.kind !== "goat" || message.kind === "task_chip") return undefined;
  if (message.personAnswer !== undefined) return undefined;
  return message.taskId;
};

/**
 * Raises the mark for a post just settled as delivered, inside that settle's transaction, and
 * returns the owner whose row changed. A message is activity: it moves the task's updated_at
 * strictly past its last update and its owner's read time, never touching the task's version.
 */
export const raiseMessageMark = Effect.fn("channelTaskMessageMarks.raise")(function* (
  sql: SqlClient.SqlClient,
  message: ChannelOutboundMessage,
  operation: string,
  now: string,
) {
  const taskId = markedTask(message, operation);
  if (taskId === undefined) return undefined;
  const [task] = yield* sql<{
    readonly owner_id: string;
    readonly updated_at: string;
  }>`SELECT owner_id, updated_at FROM channel_tasks WHERE task_id = ${taskId}`;
  if (task === undefined) return undefined;
  const [view] = yield* sql<{ readonly read_through: string | null }>`SELECT CASE
    WHEN json_valid(value_json) THEN json_extract(value_json, '$.readThrough') END AS read_through
    FROM channel_runtime_state WHERE key = ${taskViewKey(task.owner_id, taskId)}`;
  const at = Math.max(
    millis(task.updated_at) + 1,
    millis(now),
    view?.read_through == null ? 0 : millis(view.read_through) + 1,
  );
  const next = DateTime.formatIso(DateTime.makeUnsafe(at));
  yield* sql`UPDATE channel_tasks SET updated_at = ${next},
    task_json = json_set(task_json, '$.updatedAt', ${next}) WHERE task_id = ${taskId}`;
  const key = messageMarkKey(task.owner_id, taskId);
  const [stored] = yield* sql<{
    readonly value_json: string;
  }>`SELECT value_json FROM channel_runtime_state WHERE key = ${key}`;
  const current = stored === undefined ? undefined : readMessageMark(stored.value_json);
  if (current === undefined || millis(current.at) < at) {
    yield* sql`INSERT INTO channel_runtime_state (key, value_json, updated_at)
      VALUES (${key}, ${encodeMark({ at: next })}, ${now})
      ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`;
  }
  return task.owner_id;
});

/** Reads the stored marks for a JSON array of keys; tests replace it to make the lookup fail. */
export const MessageMarkLookup = Context.Reference<
  (
    keys: string,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly key: string; readonly value_json: string }>,
    SqlError,
    SqlClient.SqlClient
  >
>("goat/channels/channelTaskMessageMarks/MessageMarkLookup", {
  defaultValue: () => (keys) =>
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) => sql<{ readonly key: string; readonly value_json: string }>`SELECT s.key,
        s.value_json FROM json_each(${keys}) ids JOIN channel_runtime_state s ON s.key = ids.value`,
    ),
});

/** Distinct warnings one process remembers; past this it says so once and reports no more. */
export const MARK_WARNINGS_REMEMBERED = 1_000;

/** Warns at most once per key for the life of the process, remembering a bounded set of keys. */
export const makeMarkWarnings = () => {
  const seen = new Set<string>();
  let capped = false;
  return Effect.fn("channelTaskMessageMarks.warn")(function* (
    key: string,
    message: string,
    fields: Record<string, unknown>,
  ) {
    if (seen.has(key)) return;
    if (seen.size >= MARK_WARNINGS_REMEMBERED) {
      if (capped) return;
      capped = true;
      yield* Effect.logWarning("channel task message mark warnings stop here for this process", {
        remembered: MARK_WARNINGS_REMEMBERED,
      });
      return;
    }
    seen.add(key);
    yield* Effect.logWarning(message, fields);
  });
};

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
