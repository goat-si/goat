/**
 * Slack keeps one progress message per task: later milestones edit it, and after the answer it is
 * deleted or put back. All lossy: nothing waits on these writes, and any refusal ends them.
 * @module channelProgressMessages
 */
import {
  ChannelInputId,
  ChannelOutboundMessage,
  ChannelTaskId,
  type ChannelDeliveryId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

import type { ChannelOutboxInsert, ChannelStoredDelivery } from "./ChannelLedger.ts";
import { deliveryIdFor, taskIdFor } from "./channelIds.ts";
import { raiseMessageMark } from "./channelTaskMessageMarks.ts";
import { formatSlackOutboundMessages } from "./slack/slackMessageFormatting.ts";

const decodeOutbound = Schema.decodeUnknownSync(Schema.fromJsonString(ChannelOutboundMessage));
const encodeOutbound = Schema.encodeSync(Schema.fromJsonString(ChannelOutboundMessage));

/** Writes to one progress message are at least this far apart: four a minute per task. */
const EDIT_GAP_MS = 15_000;
/** An edit or end Slack refused or failed; its message takes no more writes. */
export const PROGRESS_REFUSED = "progress_refused";
/** A write with no live session for its workspace; the message stays editable. */
export const PROGRESS_SKIPPED = "progress_skipped";
const TERMINAL_TYPES = new Set(["task.completed", "task.failed", "task.cancelled"]);

interface TargetRow {
  readonly delivery_id: string;
  readonly cause_key: string;
  readonly state: string;
  readonly kind: string;
  readonly destination_kind: string;
  readonly external_message_id: string | null;
  readonly message_json: string;
}

/** A claimed edit or end row, as the claim returns it. */
export interface ProgressClaimRow {
  readonly row_order: number;
  readonly delivery_id: ChannelDeliveryId;
  readonly message_json: string;
  readonly attempts: number;
  readonly task_id: string | null;
  readonly destination_kind: string;
  readonly target_delivery_id: string | null;
}

/**
 * The statements that read or change progress rows. Each reaches channel_outbox through an index;
 * a test explains every one of them.
 */
export const progressStatements = (sql: SqlClient.SqlClient) => ({
  replyRow: (inputId: string) =>
    sql<TargetRow>`SELECT delivery_id, cause_key, state, kind, destination_kind,
      external_message_id, message_json FROM channel_outbox WHERE cause_key = ${"reply:" + inputId}`,
  /** The task's first interim Slack message the person heard; only one ever goes out. */
  firstInterim: (taskId: string) =>
    sql<TargetRow>`SELECT told.delivery_id, told.cause_key, told.state, told.kind,
      told.destination_kind, told.external_message_id, told.message_json FROM channel_outbox told
      WHERE told.task_id = ${taskId} AND told.destination_kind = 'slack' AND told.kind = 'receipt'
        AND told.state IN ('delivered', 'ambiguous') AND told.operation = 'post'
        AND (json_extract(told.message_json, '$.interim') = 1 OR EXISTS (
          SELECT 1 FROM channel_task_events event
          WHERE event.task_id = told.task_id
            AND event.event_id = substr(told.cause_key, 11, length(told.cause_key) - 17)
            AND told.cause_key = 'narration:' || event.event_id || ':origin'
            AND event.type IN ('task.progress', 'task.dispatch.claimed', 'task.moved')))
      ORDER BY told.rowid LIMIT 1`,
  /** Whether the message already ended: an end row other than `except`, or a refused write. */
  targetEnded: (targetDeliveryId: string, except = "") =>
    sql<{ readonly ended: number }>`SELECT EXISTS (SELECT 1 FROM channel_outbox ended
      WHERE ended.target_delivery_id = ${targetDeliveryId}
        AND ((ended.operation = 'end' AND ended.delivery_id != ${except})
          OR ended.last_error_code = ${PROGRESS_REFUSED})) AS ended`,
  lastSendStarted: (targetDeliveryId: string) =>
    sql<{ readonly at: string | null }>`SELECT MAX(at) AS at FROM (
      SELECT send_started_at AS at FROM channel_outbox WHERE delivery_id = ${targetDeliveryId}
      UNION ALL SELECT send_started_at FROM channel_outbox
        WHERE target_delivery_id = ${targetDeliveryId})`,
  /** The newest line an edit put on the message, other than `except`. */
  lastShown: (targetDeliveryId: string, except: string) =>
    sql<{ readonly message_json: string }>`SELECT message_json FROM channel_outbox
      WHERE target_delivery_id = ${targetDeliveryId} AND operation = 'edit'
        AND state IN ('delivered', 'ambiguous') AND delivery_id != ${except}
      ORDER BY rowid DESC LIMIT 1`,
  editShown: (targetDeliveryId: string) =>
    sql<{ readonly shown: number }>`SELECT EXISTS (SELECT 1 FROM channel_outbox shown
      WHERE shown.target_delivery_id = ${targetDeliveryId} AND shown.operation = 'edit'
        AND shown.state IN ('delivered', 'ambiguous')) AS shown`,
  /** The state of the message telling the task's latest outcome, when it has one. */
  answerState: (taskId: string) =>
    sql<{ readonly state: string }>`SELECT answer.state FROM channel_outbox answer
      WHERE answer.cause_key = 'narration:' || (SELECT latest.event_id FROM channel_task_events latest
        WHERE latest.task_id = ${taskId}
          AND latest.type IN ('task.completed', 'task.failed', 'task.cancelled')
        ORDER BY latest.task_version DESC LIMIT 1) || ':origin'`,
  /** Whether a claimed edit is stale: a newer open row of its task, or its message's end. */
  overtaken: (input: {
    readonly taskId: string;
    readonly destinationKind: string;
    readonly rowOrder: number;
    readonly targetDeliveryId: string;
  }) =>
    sql<{ readonly overtaken: number }>`SELECT (EXISTS (SELECT 1 FROM channel_outbox newer
        WHERE newer.task_id = ${input.taskId} AND newer.destination_kind = ${input.destinationKind}
          AND newer.state IN ('pending', 'delivering') AND newer.rowid > ${input.rowOrder})
      OR EXISTS (SELECT 1 FROM channel_outbox ended
        WHERE ended.target_delivery_id = ${input.targetDeliveryId} AND ended.operation = 'end'))
      AS overtaken`,
  supersedeTargetEdits: (input: {
    readonly targetDeliveryId: string;
    readonly before: number;
    readonly now: string;
  }) =>
    sql`UPDATE channel_outbox SET state = 'superseded', updated_at = ${input.now}
      WHERE target_delivery_id = ${input.targetDeliveryId} AND operation = 'edit'
        AND state = 'pending' AND rowid < ${input.before}`,
  supersedeTaskEdits: (input: {
    readonly taskId: string;
    readonly destinationKind: string;
    readonly except: string;
    readonly now: string;
  }) =>
    sql`UPDATE channel_outbox SET state = 'superseded', updated_at = ${input.now}
      WHERE task_id = ${input.taskId} AND destination_kind = ${input.destinationKind}
        AND state IN ('pending', 'delivering') AND state = 'pending' AND operation = 'edit'
        AND delivery_id != ${input.except}`,
});

const onePart = (text: string, target: ChannelOutboundMessage) =>
  formatSlackOutboundMessages({ text, mentionUserId: target.mentionActorId }).length === 1;

/** A sent Slack message that can take an edit: delivered, with its ts, one part, not ended. */
const editable = Effect.fn("channelProgressMessages.editable")(function* (
  sql: SqlClient.SqlClient,
  row: TargetRow | undefined,
  except?: string,
) {
  if (
    row === undefined ||
    row.state !== "delivered" ||
    row.destination_kind !== "slack" ||
    row.kind !== "receipt" ||
    row.external_message_id === null
  )
    return undefined;
  const message = decodeOutbound(row.message_json);
  if ((message.options?.length ?? 0) > 0 || !onePart(message.text, message)) return undefined;
  const [ended] = yield* progressStatements(sql).targetEnded(row.delivery_id, except);
  if (ended?.ended === 1) return undefined;
  return { row, deliveryId: row.delivery_id, externalMessageId: row.external_message_id, message };
});

/**
 * The one message a task's later progress edits: the request's reply when that request made only
 * this task, or else the task's first interim message the person heard.
 */
const progressTarget = Effect.fn("channelProgressMessages.target")(function* (
  sql: SqlClient.SqlClient,
  taskId: string,
) {
  const statements = progressStatements(sql);
  const [task] = yield* sql<{ readonly input_id: string | null }>`
    SELECT json_extract(task_json, '$.originInputId') AS input_id FROM channel_tasks
    WHERE task_id = ${taskId}`;
  if (task?.input_id === undefined || task.input_id === null) return undefined;
  const [reply] = yield* statements.replyRow(task.input_id);
  if (reply === undefined || (reply.state !== "delivered" && reply.state !== "ambiguous")) {
    const [first] = yield* statements.firstInterim(taskId);
    return yield* editable(sql, first);
  }
  // Sibling tasks of one request all read its reply; none of them may edit it.
  const inputId = ChannelInputId.make(task.input_id);
  if (taskId !== taskIdFor(inputId, 0)) return undefined;
  const siblings = yield* sql`SELECT 1 AS found FROM channel_tasks
    WHERE task_id = ${taskIdFor(inputId, 1)}`;
  if (siblings.length > 0) return undefined;
  return yield* editable(sql, reply);
});

/**
 * Turns an interim post the person would not otherwise hear into an edit of the task's progress
 * message, due once the last write to that message is 15 s old. False when there is no such
 * message, and the caller sets the post aside as before.
 */
export const convertToEdit = Effect.fn("channelProgressMessages.convertToEdit")(function* (
  sql: SqlClient.SqlClient,
  row: Pick<ProgressClaimRow, "row_order" | "delivery_id" | "task_id" | "destination_kind">,
  message: ChannelOutboundMessage,
  now: string,
) {
  if (row.destination_kind !== "slack" || row.task_id === null) return false;
  const target = yield* progressTarget(sql, row.task_id);
  if (target === undefined) return false;
  const statements = progressStatements(sql);
  const [last] = yield* statements.lastSendStarted(target.deliveryId);
  const gap =
    last?.at === undefined || last.at === null
      ? now
      : DateTime.formatIso(DateTime.makeUnsafe(Date.parse(last.at) + EDIT_GAP_MS));
  yield* sql`UPDATE channel_outbox SET operation = 'edit', target_delivery_id = ${target.deliveryId},
    input_id = NULL, message_json = ${encodeOutbound({ ...message, interim: true })},
    state = 'pending', attempts = 0, send_started_at = NULL,
    next_attempt_at = ${gap > now ? gap : now}, updated_at = ${now}
    WHERE delivery_id = ${row.delivery_id}`;
  yield* statements.supersedeTargetEdits({
    targetDeliveryId: target.deliveryId,
    before: row.row_order,
    now,
  });
  return true;
});

const setAside = (sql: SqlClient.SqlClient, row: ProgressClaimRow, now: string) =>
  sql`UPDATE channel_outbox SET state = 'superseded', updated_at = ${now}
    WHERE delivery_id = ${row.delivery_id}`.pipe(Effect.as(null));

const readTarget = Effect.fn("channelProgressMessages.readTarget")(function* (
  sql: SqlClient.SqlClient,
  row: ProgressClaimRow,
) {
  if (row.target_delivery_id === null) return undefined;
  const [target] = yield* sql<TargetRow>`SELECT delivery_id, cause_key, state, kind,
    destination_kind, external_message_id, message_json FROM channel_outbox
    WHERE delivery_id = ${row.target_delivery_id}`;
  return target;
});

const claimed = (
  row: ProgressClaimRow,
  message: ChannelOutboundMessage,
  progress: NonNullable<ChannelStoredDelivery["progress"]>,
): ChannelStoredDelivery => ({
  deliveryId: row.delivery_id,
  message: { ...message, deliveryId: row.delivery_id },
  attempts: row.attempts,
  progress,
});

/**
 * Builds a claimed edit: the message's original text, a blank line, and the newest line. Null,
 * with the row set aside, when the message ended, would need two parts, or already reads so.
 */
export const claimEdit = Effect.fn("channelProgressMessages.claimEdit")(function* (
  sql: SqlClient.SqlClient,
  row: ProgressClaimRow,
  now: string,
) {
  const target = yield* editable(sql, yield* readTarget(sql, row));
  if (target === undefined) return yield* setAside(sql, row, now);
  const original = target.message.text;
  const text = original + "\n\n" + decodeOutbound(row.message_json).text;
  if (!onePart(text, target.message)) return yield* setAside(sql, row, now);
  const statements = progressStatements(sql);
  const [shown] = yield* statements.lastShown(target.deliveryId, row.delivery_id);
  const showing =
    shown === undefined ? original : original + "\n\n" + decodeOutbound(shown.message_json).text;
  if (text === showing) return yield* setAside(sql, row, now);
  yield* statements.supersedeTargetEdits({
    targetDeliveryId: target.deliveryId,
    before: row.row_order,
    now,
  });
  return claimed(
    row,
    { ...target.message, text },
    {
      operation: "edit",
      externalMessageId: target.externalMessageId,
    },
  );
});

/** Whether a progress message may be deleted: a milestone, or a fallback or fixed line. */
const removable = Effect.fn("channelProgressMessages.removable")(function* (
  sql: SqlClient.SqlClient,
  target: TargetRow,
) {
  if (!target.cause_key.startsWith("reply:")) return true;
  const [receipt] = yield* sql<{ readonly source: string }>`SELECT source
    FROM channel_session_receipts WHERE input_id = ${target.cause_key.slice("reply:".length)}`;
  return receipt?.source === "fallback" || receipt?.source === "fixed";
});

/**
 * Ends a message once the task's latest answer settled, dropping its waiting edits. A delivered
 * answer deletes a milestone or fallback/fixed line and restores anything else edited; a failed
 * answer keeps the message; with no answer nothing is deleted.
 */
export const claimEnd = Effect.fn("channelProgressMessages.claimEnd")(function* (
  sql: SqlClient.SqlClient,
  row: ProgressClaimRow,
  now: string,
) {
  const target = yield* editable(sql, yield* readTarget(sql, row), row.delivery_id);
  if (target === undefined || row.task_id === null) return yield* setAside(sql, row, now);
  const statements = progressStatements(sql);
  yield* statements.supersedeTargetEdits({
    targetDeliveryId: target.deliveryId,
    before: Number.MAX_SAFE_INTEGER,
    now,
  });
  const [answer] = yield* statements.answerState(row.task_id);
  const [shown] = yield* statements.editShown(target.deliveryId);
  const restore = shown?.shown === 1 ? ("restore" as const) : undefined;
  const operation =
    answer === undefined
      ? restore
      : answer.state !== "delivered"
        ? undefined
        : (yield* removable(sql, target.row))
          ? ("delete" as const)
          : restore;
  if (operation === undefined) return yield* setAside(sql, row, now);
  return claimed(row, operation === "restore" ? target.message : decodeOutbound(row.message_json), {
    operation,
    externalMessageId: target.externalMessageId,
  });
});

/** Whether a claimed edit is no longer wanted at hand-over. */
export const editOvertaken = Effect.fn("channelProgressMessages.editOvertaken")(function* (
  sql: SqlClient.SqlClient,
  row: {
    readonly task_id: string | null;
    readonly destination_kind: string;
    readonly row_order: number;
    readonly target_delivery_id: string | null;
  },
) {
  if (row.task_id === null || row.target_delivery_id === null) return true;
  const [found] = yield* progressStatements(sql).overtaken({
    taskId: row.task_id,
    destinationKind: row.destination_kind,
    rowOrder: row.row_order,
    targetDeliveryId: row.target_delivery_id,
  });
  return found?.overtaken === 1;
});

/** The end row a task's outcome adds when the task has a progress message, in the same commit. */
export const progressEndRows = Effect.fn("channelProgressMessages.endRows")(function* (
  sql: SqlClient.SqlClient,
  event: { readonly task_id: string; readonly type: string },
) {
  if (!TERMINAL_TYPES.has(event.type)) return [];
  const target = yield* progressTarget(sql, event.task_id);
  if (target === undefined) return [];
  const causeKey = "progress-end:" + target.deliveryId;
  const deliveryId = deliveryIdFor(causeKey);
  const taskId = ChannelTaskId.make(event.task_id);
  const end: ChannelOutboxInsert = {
    deliveryId,
    causeKey,
    taskId,
    operation: "end",
    targetDeliveryId: target.deliveryId,
    message: {
      deliveryId,
      destination: target.message.destination,
      kind: "receipt",
      text: "",
      taskId,
      interim: true,
    },
  };
  return [end];
});

/**
 * Commits outbox rows; a cause key already stored is a no-op. A row really added for a task makes
 * any waiting edit of that task's progress message stale, and raises its task's message mark in
 * the same transaction.
 */
export const insertOutboxRows = (
  sql: SqlClient.SqlClient,
  deliveries: ReadonlyArray<ChannelOutboxInsert>,
  now: string,
) =>
  Effect.forEach(
    deliveries,
    (delivery) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const inserted = yield* sql<{ readonly delivery_id: string }>`
          INSERT INTO channel_outbox (
            delivery_id, cause_key, input_id, task_id, kind, destination_kind, message_json,
            state, attempts, next_attempt_at, created_at, updated_at, operation, target_delivery_id
          ) VALUES (
            ${delivery.deliveryId}, ${delivery.causeKey}, ${delivery.inputId ?? null},
            ${delivery.taskId ?? null}, ${delivery.message.kind},
            ${delivery.message.destination.kind}, ${encodeOutbound(delivery.message)},
            'pending', 0, ${now}, ${now}, ${now}, ${delivery.operation ?? "post"},
            ${delivery.targetDeliveryId ?? null}
          )
          ON CONFLICT DO NOTHING
          RETURNING delivery_id`;
          if (inserted.length === 0) return;
          yield* raiseMessageMark(sql, delivery, now);
          if (delivery.taskId === undefined) return;
          yield* progressStatements(sql).supersedeTaskEdits({
            taskId: delivery.taskId,
            destinationKind: delivery.message.destination.kind,
            except: delivery.deliveryId,
            now,
          });
        }),
      ),
    { discard: true },
  );
