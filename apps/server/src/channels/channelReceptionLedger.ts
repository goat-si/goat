import { ChannelReceptionResult, type ChannelTask, type ChannelTaskEvent } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import type {
  ChannelLedger,
  ChannelStoredInput,
  ChannelTaskEventWrite,
  ChannelOutboxInsert,
} from "./ChannelLedger.ts";
import { ChannelLedgerError } from "./channelLedgerError.ts";

const encodeDecision = Schema.encodeSync(Schema.fromJsonString(ChannelReceptionResult));
const encodeReply = (reply: { text: string }) => JSON.stringify(reply);
const encodeFailure = (failure: { reason: string; message: string }) => JSON.stringify(failure);
const encodeStrings = (strings: ReadonlyArray<string>) => JSON.stringify(strings);
const isLedgerError = Schema.is(ChannelLedgerError);
const toLedgerError = (detail: string) => (cause: unknown) =>
  isLedgerError(cause) ? cause : new ChannelLedgerError({ reason: "persistence", detail, cause });

export const receptionLedger = (
  sql: SqlClient.SqlClient,
  deps: {
    fence: (owner: string | undefined) => Effect.Effect<void, SqlError | ChannelLedgerError>;
    readInbox: (
      inputId: string,
    ) => Effect.Effect<ChannelStoredInput | undefined, SqlError | ChannelLedgerError>;
    insertTask: (
      task: ChannelTask,
      ownerId: string,
      event: ChannelTaskEvent,
    ) => Effect.Effect<void, SqlError | ChannelLedgerError>;
    writeTaskEvent: (
      write: ChannelTaskEventWrite,
    ) => Effect.Effect<number, SqlError | ChannelLedgerError>;
    insertDeliveries: (
      rows: ReadonlyArray<ChannelOutboxInsert>,
      now: string,
    ) => Effect.Effect<void, SqlError | ChannelLedgerError>;
  },
): Pick<
  ChannelLedger["Service"],
  | "beginReception"
  | "completeReception"
  | "failReception"
  | "claimForSession"
  | "commitSessionReceipt"
  | "takeSessionAcknowledgment"
> => {
  const { fence, readInbox, insertTask, writeTaskEvent, insertDeliveries } = deps;
  const operations: ReturnType<typeof receptionLedger> = {
    beginReception: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* fence(input.owner);
            const rows = yield* sql<{ readonly input_id: string }>`
              UPDATE channel_inbox SET
                state = 'processing',
                reception_id = ${input.receptionId},
                read_at = COALESCE(read_at, ${input.readAt})
              WHERE input_id = ${input.inputId} AND state IN ('accepted', 'processing')
                AND (reception_id IS NULL OR (reception_id NOT LIKE 'channel-session:%' AND reception_id NOT LIKE 'channel-session-ack:%'))
              RETURNING input_id
            `;
            return rows.length === 0 ? undefined : yield* readInbox(input.inputId);
          }),
        )
        .pipe(Effect.mapError(toLedgerError("beginReception"))),

    completeReception: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* fence(input.owner);
            const created =
              input.createdTasks ?? (input.createdTask === undefined ? [] : [input.createdTask]);
            const taskIds = [
              ...created.map(({ task }) => task.taskId),
              ...(input.taskEvents ?? []).map((write) => write.next.taskId),
            ];
            const rows = yield* sql<{ readonly owner_id: string }>`
              UPDATE channel_inbox SET
                state = 'replied',
                decision_json = ${encodeDecision(input.decision)},
                reply_json = ${encodeReply({ text: input.replyText })},
                task_ids_json = ${encodeStrings(taskIds)}
              WHERE input_id = ${input.inputId} AND state = 'processing'
                AND reception_id = ${input.receptionId}
              RETURNING owner_id
            `;
            const row = rows[0];
            if (row === undefined) return false;
            for (const item of created) yield* insertTask(item.task, row.owner_id, item.event);
            for (const write of input.taskEvents ?? []) yield* writeTaskEvent(write);
            yield* insertDeliveries(input.deliveries, input.now);
            return true;
          }),
        )
        .pipe(Effect.mapError(toLedgerError("completeReception"))),

    failReception: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* fence(input.owner);
            const rows = yield* sql<{ readonly input_id: string }>`
              UPDATE channel_inbox SET state = 'failed',
                failure_json = ${encodeFailure(input.failure)}
              WHERE input_id = ${input.inputId} AND state = 'processing'
                AND reception_id = ${input.receptionId}
              RETURNING input_id
            `;
            if (rows.length === 0) return false;
            yield* insertDeliveries(input.deliveries, input.now);
            return true;
          }),
        )
        .pipe(Effect.mapError(toLedgerError("failReception"))),

    claimForSession: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* fence(input.owner);
            const rows = yield* sql<{
              owner_id: string;
            }>`UPDATE channel_inbox SET state = 'processing',
      reception_id = ${input.receptionId}, read_at = COALESCE(read_at, ${input.now}),
      task_ids_json = ${encodeStrings([input.createdTask.task.taskId])}
      WHERE input_id = ${input.inputId} AND state = 'accepted'
        AND NOT EXISTS (SELECT 1 FROM channel_tasks t
          WHERE t.conversation_id = channel_inbox.conversation_id
            AND (t.status IN ('received', 'dispatching', 'running', 'waiting_input') OR EXISTS (
              SELECT 1 FROM channel_outbox o WHERE o.task_id = t.task_id AND o.kind IN ('result', 'failure')
                AND o.state IN ('pending', 'delivering')) OR EXISTS (
              SELECT 1 FROM channel_task_events e WHERE e.task_id = t.task_id
                AND e.type IN ('task.completed', 'task.failed', 'task.cancelled') AND e.narration_state = 'pending')))
      RETURNING owner_id`;
            if (rows[0] === undefined) return false;
            yield* insertTask(input.createdTask.task, rows[0].owner_id, input.createdTask.event);
            return true;
          }),
        )
        .pipe(Effect.mapError(toLedgerError("claimForSession"))),
    takeSessionAcknowledgment: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* fence(input.owner);
            const rows = yield* sql`UPDATE channel_inbox SET reception_id = ${input.receptionId}
      WHERE input_id = ${input.inputId} AND state = 'processing'
        AND reception_id = ${input.expectedReceptionId} RETURNING input_id`;
            return rows.length > 0;
          }),
        )
        .pipe(Effect.mapError(toLedgerError("takeSessionAcknowledgment"))),
    commitSessionReceipt: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* fence(input.owner);
            const rows = yield* sql`UPDATE channel_inbox SET state = 'replied',
      reply_json = ${encodeReply({ text: input.text })}
      WHERE input_id = ${input.inputId} AND state = 'processing'
        AND reception_id = ${input.expectedReceptionId} RETURNING input_id`;
            if (rows.length === 0) return false;
            yield* sql`INSERT INTO channel_session_receipts
      (input_id, task_id, source, run_id, turn_item_id, text, committed_at)
      VALUES (${input.inputId}, ${input.taskId}, ${input.source}, ${input.runId ?? null},
        ${input.turnItemId ?? null}, ${input.text}, ${input.now})`;
            yield* insertDeliveries(input.deliveries, input.now);
            return true;
          }),
        )
        .pipe(Effect.mapError(toLedgerError("commitSessionReceipt"))),
  };
  return {
    beginReception: Effect.fn("ChannelLedger.beginReception")(operations.beginReception),
    completeReception: Effect.fn("ChannelLedger.completeReception")(operations.completeReception),
    failReception: Effect.fn("ChannelLedger.failReception")(operations.failReception),
    claimForSession: Effect.fn("ChannelLedger.claimForSession")(operations.claimForSession),
    commitSessionReceipt: Effect.fn("ChannelLedger.commitSessionReceipt")(
      operations.commitSessionReceipt,
    ),
    takeSessionAcknowledgment: Effect.fn("ChannelLedger.takeSessionAcknowledgment")(
      operations.takeSessionAcknowledgment,
    ),
  };
};
