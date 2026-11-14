import { ChannelOutboundMessage, type ChannelDeliveryId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import type { SqlError } from "effect/sql/SqlError";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import type { ChannelDeliveryOutcome, ChannelStoredDelivery } from "./ChannelLedger.ts";
import { ChannelLedgerError } from "./channelLedgerError.ts";
import {
  copyUndeliveredReplies,
  copyUndeliveredReply,
  type UndeliveredSourceRow,
} from "./channelUndeliveredReplies.ts";
import { interimAlreadyHeard, isInterimMessage } from "./channelInterimMessages.ts";
import {
  claimEdit,
  claimEnd,
  convertToEdit,
  editOvertaken,
  type ProgressClaimRow,
} from "./channelProgressMessages.ts";
import { raiseMessageMark } from "./channelTaskMessageMarks.ts";

const decodeOutbound = Schema.decodeUnknownSync(Schema.fromJsonString(ChannelOutboundMessage));
const isLedgerError = Schema.is(ChannelLedgerError);
const encodeIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const mapError = (detail: string) => (cause: unknown) =>
  isLedgerError(cause) ? cause : new ChannelLedgerError({ reason: "persistence", detail, cause });
/** How long after its input a reply receipt may still go out. */
const RECEIPT_DEADLINE_MS = 60_000;
/** Interim messages one claim may set aside before it commits and lets the worker come back. */
const SET_ASIDE_PER_CLAIM = 50;
const RECEIPT_CAUSE = "reply:";

/** Part of the ChannelLedger service, declared here to keep that file within its code budget. */
export interface UnsentDeliveryRelease {
  /**
   * Puts external rows that were never handed to their transport, untouched since `before` and
   * not in `exclude`, back to pending with their attempt kept, at most `limit` of them, oldest
   * first. `remaining` says whether other such rows still wait: younger ones, or past the limit.
   */
  readonly releaseUnsentDeliveries: (input: {
    readonly owner: string;
    readonly now: string;
    readonly before: string;
    readonly exclude: ReadonlyArray<ChannelDeliveryId>;
    readonly limit: number;
  }) => Effect.Effect<
    { readonly released: number; readonly remaining: boolean },
    ChannelLedgerError
  >;
}

/**
 * The rows reconciliation may put back, and whether any such row still waits. Both repeat the
 * open-row predicate of channel_outbox_due_idx so they read that index instead of the history.
 */
export const unsentDeliveryQueries = (
  sql: SqlClient.SqlClient,
  input: { readonly before: string; readonly exclude: string; readonly limit: number },
) => {
  // A local destination records once per delivery id, so its row may go again even after a send.
  const unsent = sql`state IN ('pending', 'delivering') AND state = 'delivering'
    AND (destination_kind IN ('goat', 'mcp') OR send_started_at IS NULL)
    AND delivery_id NOT IN (SELECT value FROM json_each(${input.exclude}))`;
  return {
    selection: sql`SELECT delivery_id FROM channel_outbox
      WHERE ${unsent} AND updated_at <= ${input.before}
      ORDER BY created_at, rowid LIMIT ${input.limit}`,
    remaining: sql`SELECT EXISTS (SELECT 1 FROM channel_outbox WHERE ${unsent}) AS waiting`,
  };
};

interface ClaimRow extends ProgressClaimRow {
  readonly cause_key: string;
  readonly input_id: string | null;
  readonly kind: string;
  readonly operation: string;
}

/**
 * Marks the oldest due rows delivering. Edit and end rows never hold a post back, and only one
 * write to a sent message is in flight at a time. An end row also waits while the task's latest
 * outcome is not yet narrated or its message is still going out, so it reads the newest answer.
 */
export const claimDueStatement = (
  sql: SqlClient.SqlClient,
  input: {
    readonly now: string;
    readonly limit: number;
    readonly receiptsOnly?: boolean | undefined;
    /** Takes no edit or end row, while the worker already runs as many as it allows. */
    readonly postsOnly?: boolean | undefined;
  },
) => sql<ClaimRow>`UPDATE channel_outbox SET state = 'delivering', attempts = attempts + 1,
  send_started_at = NULL, updated_at = ${input.now}
  WHERE delivery_id IN (
    SELECT due.delivery_id FROM channel_outbox due
    WHERE due.state IN ('pending', 'delivering') AND due.state = 'pending'
      AND due.next_attempt_at <= ${input.now}
      AND (${input.receiptsOnly === undefined ? 1 : 0} = 1
        OR (${input.receiptsOnly === true ? 1 : 0} = 1 AND due.cause_key = 'reply:' || due.input_id)
        OR (${input.receiptsOnly === false ? 1 : 0} = 1 AND due.cause_key != 'reply:' || COALESCE(due.input_id, '')))
      AND (due.cause_key = 'reply:' || due.input_id OR (
        ((due.task_id IS NULL AND (due.input_id IS NULL OR EXISTS (
          SELECT 1 FROM channel_inbox rejected WHERE rejected.input_id = due.input_id
            AND rejected.state = 'rejected'))) OR EXISTS (
          SELECT 1 FROM channel_outbox receipt WHERE receipt.cause_key = 'reply:' ||
            COALESCE(due.input_id, (SELECT json_extract(t.task_json, '$.originInputId')
              FROM channel_tasks t WHERE t.task_id = due.task_id))
            AND receipt.state IN ('delivered', 'failed', 'ambiguous')))
        AND NOT EXISTS (SELECT 1 FROM channel_outbox earlier
          WHERE earlier.task_id = due.task_id AND earlier.destination_kind = due.destination_kind
            AND earlier.state IN ('pending', 'delivering') AND earlier.rowid < due.rowid
            AND earlier.operation = 'post')))
      AND (${input.postsOnly === true ? 1 : 0} = 0 OR due.operation = 'post')
      AND (due.operation = 'post' OR NOT EXISTS (SELECT 1 FROM channel_outbox busy
        WHERE busy.target_delivery_id = due.target_delivery_id AND busy.state = 'delivering'))
      -- The unary plus keeps this off the pending-narration index, so it searches by task.
      AND (due.operation != 'end' OR (NOT EXISTS (SELECT 1 FROM channel_task_events told
          WHERE told.task_id = due.task_id AND +told.narration_state = 'pending'
            AND told.type IN ('task.completed', 'task.failed', 'task.cancelled'))
        AND NOT EXISTS (SELECT 1 FROM channel_outbox answer
          WHERE answer.cause_key = 'narration:' || (SELECT latest.event_id
              FROM channel_task_events latest WHERE latest.task_id = due.task_id
                AND latest.type IN ('task.completed', 'task.failed', 'task.cancelled')
              ORDER BY latest.task_version DESC LIMIT 1) || ':origin'
            AND answer.state IN ('pending', 'delivering'))))
    ORDER BY CASE WHEN due.cause_key = 'reply:' || due.input_id THEN 0 ELSE 1 END,
      due.created_at, due.rowid LIMIT ${input.limit})
  RETURNING rowid AS row_order, delivery_id, message_json, attempts, cause_key, input_id,
    task_id, kind, destination_kind, operation, target_delivery_id`;

/** The outbox operations: claiming due rows, recording how their sends went, and recovery. */
export interface ChannelDeliveryLedgerOps extends UnsentDeliveryRelease {
  /**
   * Marks the oldest due rows as delivering. A row waits while an earlier row for the same task
   * and destination kind is still pending or in flight, so a receipt goes out before its result.
   */
  readonly claimDueDeliveries: (input: {
    readonly owner: string;
    readonly now: string;
    readonly limit: number;
    readonly receiptsOnly?: boolean | undefined;
  }) => Effect.Effect<ReadonlyArray<ChannelStoredDelivery>, ChannelLedgerError>;
  /**
   * claimDueDeliveries, also saying how many interim messages it set aside as already heard.
   * It sets aside a bounded number per call, so a long backlog takes several calls.
   */
  readonly claimDue: (input: {
    readonly owner: string;
    readonly now: string;
    readonly limit: number;
    readonly receiptsOnly?: boolean | undefined;
    readonly postsOnly?: boolean | undefined;
  }) => Effect.Effect<
    { readonly deliveries: ReadonlyArray<ChannelStoredDelivery>; readonly setAside: number },
    ChannelLedgerError
  >;
  readonly recordDelivery: (input: {
    readonly owner: string;
    readonly deliveryId: ChannelDeliveryId;
    readonly outcome: ChannelDeliveryOutcome;
    readonly now: string;
    readonly attempt?: number | undefined;
  }) => Effect.Effect<void, ChannelLedgerError>;
  readonly expireReceipts: (input: {
    readonly owner: string;
    readonly now: string;
  }) => Effect.Effect<void, ChannelLedgerError>;
  /**
   * Records that an external delivery is being handed to its transport now. False when the row
   * is no longer this claim's (its receipt expired, or recovery took it): then it is not sent.
   */
  readonly markSending: (input: {
    readonly owner: string;
    readonly deliveryId: ChannelDeliveryId;
    readonly attempt: number;
    readonly now: string;
  }) => Effect.Effect<boolean, ChannelLedgerError>;
  /**
   * After a restart: GOAT bot and MCP deliveries and external ones never handed to their
   * transport retry; external ones handed over become ambiguous.
   */
  readonly settleInterruptedDeliveries: (input: {
    readonly owner: string;
    readonly now: string;
  }) => Effect.Effect<void, ChannelLedgerError>;
}

export const deliveryLedger = (
  sql: SqlClient.SqlClient,
  fence: (owner: string | undefined) => Effect.Effect<void, SqlError | ChannelLedgerError>,
  changed: Effect.Effect<void>,
  expired: Effect.Effect<void>,
  announce: (ownerIds: Iterable<string>) => Effect.Effect<void>,
): ChannelDeliveryLedgerOps => {
  const expireRows = Effect.fn("channelDeliveryLedger.expireRows")(function* (now: string) {
    // Only a send that reached a transport may have been seen; one never handed over failed.
    const rows = yield* sql<
      UndeliveredSourceRow & { readonly state: string }
    >`UPDATE channel_outbox SET
    state = CASE WHEN state = 'delivering' AND (send_started_at IS NOT NULL
      OR destination_kind IN ('goat', 'mcp')) THEN 'ambiguous' ELSE 'failed' END,
    last_error_code = 'receipt_deadline', updated_at = ${now}
    WHERE state IN ('pending', 'delivering') AND EXISTS (
      SELECT 1 FROM channel_inbox i WHERE channel_outbox.cause_key = 'reply:' || i.input_id
        AND i.accepted_at <= ${DateTime.formatIso(DateTime.makeUnsafe(Date.parse(now) - RECEIPT_DEADLINE_MS))})
    RETURNING delivery_id, input_id, task_id, kind, destination_kind, message_json,
      last_error_code, state, operation`;
    yield* Effect.forEach(
      rows,
      (row) =>
        copyUndeliveredReply(sql, row, row.state === "ambiguous" ? "ambiguous" : "failed", now),
      { discard: true },
    );
    return rows;
  });
  // Rows held behind an expired receipt are free now, so the channel loop is told once the
  // operation's own transaction commits. Callers never nest these operations in another one.
  const expiring = <A, E, R>(
    run: (expire: (now: string) => Effect.Effect<void, SqlError>) => Effect.Effect<A, E, R>,
  ) =>
    Effect.suspend(() => {
      let count = 0;
      const expire = (now: string) =>
        expireRows(now).pipe(
          Effect.map((rows) => {
            count += rows.length;
          }),
        );
      return run(expire).pipe(Effect.tap(() => (count > 0 ? expired : Effect.void)));
    });

  const operations: ReturnType<typeof deliveryLedger> = {
    expireReceipts: (input) =>
      expiring((expire) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              yield* fence(input.owner);
              yield* expire(input.now);
            }),
          )
          .pipe(Effect.mapError(mapError("expireReceipts"))),
      ),
    claimDue: (input) =>
      expiring((expire) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              yield* fence(input.owner);
              yield* expire(input.now);
              const claimRound = Effect.fn("channelDeliveryLedger.claimRound")(function* (
                limit: number,
              ) {
                const rows = yield* claimDueStatement(sql, {
                  now: input.now,
                  limit,
                  receiptsOnly: input.receiptsOnly,
                  postsOnly: input.postsOnly,
                });
                const claimed = yield* Effect.forEach(
                  rows.toSorted((a, b) => {
                    const aReceipt = a.cause_key === "reply:" + a.input_id;
                    const bReceipt = b.cause_key === "reply:" + b.input_id;
                    return Number(bReceipt) - Number(aReceipt) || a.row_order - b.row_order;
                  }),
                  (row) =>
                    Effect.gen(function* () {
                      if (row.operation === "edit") return yield* claimEdit(sql, row, input.now);
                      if (row.operation === "end") return yield* claimEnd(sql, row, input.now);
                      const message = decodeOutbound(row.message_json);
                      if (
                        (yield* isInterimMessage(sql, row, message)) &&
                        (yield* interimAlreadyHeard(sql, row))
                      ) {
                        // Slack edits the message the person heard instead; elsewhere the row is set aside.
                        if (!(yield* convertToEdit(sql, row, message, input.now))) {
                          yield* sql`UPDATE channel_outbox SET state = 'superseded',
                          updated_at = ${input.now} WHERE delivery_id = ${row.delivery_id}`;
                        }
                        return null;
                      }
                      const receipt =
                        row.input_id !== null && row.cause_key === "reply:" + row.input_id;
                      const inbox = receipt
                        ? yield* sql<{ readonly accepted_at: string }>`
          SELECT accepted_at FROM channel_inbox WHERE input_id = ${row.input_id}`
                        : [];
                      const delivery: ChannelStoredDelivery = {
                        deliveryId: row.delivery_id,
                        message,
                        attempts: row.attempts,
                        ...(inbox[0] === undefined
                          ? {}
                          : {
                              receiptDeadline:
                                Date.parse(inbox[0].accepted_at) + RECEIPT_DEADLINE_MS,
                            }),
                      };
                      return delivery;
                    }),
                );
                return claimed;
              });
              // A superseded interim message frees the task's next row, so claim again until a
              // round supersedes nothing, setting at most a bounded number aside per transaction;
              // the worker counts them and comes back for the rest.
              const deliveries: Array<
                NonNullable<Effect.Success<ReturnType<typeof claimRound>>[number]>
              > = [];
              let setAside = 0;
              while (deliveries.length < input.limit && setAside < SET_ASIDE_PER_CLAIM) {
                const round = yield* claimRound(input.limit - deliveries.length);
                const sent = round.filter((delivery) => delivery !== null);
                deliveries.push(...sent);
                setAside += round.length - sent.length;
                if (sent.length === round.length) break;
              }
              return { deliveries, setAside };
            }),
          )
          .pipe(Effect.mapError(mapError("claimDueDeliveries"))),
      ),
    claimDueDeliveries: (input) =>
      operations.claimDue(input).pipe(Effect.map((claimed) => claimed.deliveries)),
    markSending: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* fence(input.owner);
            const handOverNow = DateTime.formatIso(yield* DateTime.now);
            const [row] = yield* sql<{
              readonly cause_key: string;
              readonly operation: string;
              readonly task_id: string | null;
              readonly destination_kind: string;
              readonly row_order: number;
              readonly target_delivery_id: string | null;
            }>`SELECT cause_key, operation, task_id, destination_kind, rowid AS row_order,
                target_delivery_id
              FROM channel_outbox WHERE delivery_id = ${input.deliveryId} AND state = 'delivering'
                AND attempts = ${input.attempt}`;
            if (row === undefined) return false;
            // An edit something newer replaced since its claim is dropped instead of sent.
            if (row.operation === "edit" && (yield* editOvertaken(sql, row))) {
              yield* sql`UPDATE channel_outbox SET state = 'superseded', updated_at = ${handOverNow}
                WHERE delivery_id = ${input.deliveryId} AND state = 'delivering'
                  AND attempts = ${input.attempt}`;
              return false;
            }
            // Only a reply receipt has a deadline. Its cause key names the input, as in expireRows;
            // the nullable input_id column does not.
            if (row.cause_key.startsWith(RECEIPT_CAUSE)) {
              const deadline = DateTime.formatIso(
                DateTime.makeUnsafe(Date.parse(handOverNow) - RECEIPT_DEADLINE_MS),
              );
              const expired = yield* sql<{ readonly input_id: string }>`SELECT input_id
                FROM channel_inbox WHERE input_id = ${row.cause_key.slice(RECEIPT_CAUSE.length)}
                  AND accepted_at <= ${deadline}`;
              if (expired.length > 0) return false;
            }
            const marked = yield* sql<{ readonly delivery_id: string }>`UPDATE channel_outbox
              SET send_started_at = ${handOverNow}
              WHERE delivery_id = ${input.deliveryId} AND state = 'delivering'
                AND attempts = ${input.attempt}
              RETURNING delivery_id`;
            return marked.length > 0;
          }),
        )
        .pipe(Effect.mapError(mapError("markSending"))),
    settleInterruptedDeliveries: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* fence(input.owner);
            // Local destinations record idempotently, and an external row never handed to its
            // transport was not sent, so both simply go again.
            yield* sql`
              UPDATE channel_outbox SET state = 'pending', updated_at = ${input.now}
              WHERE state = 'delivering'
                AND (destination_kind IN ('goat', 'mcp') OR send_started_at IS NULL)
            `;
            const interrupted = yield* sql<UndeliveredSourceRow>`
              UPDATE channel_outbox SET state = 'ambiguous', last_error_code = 'interrupted',
                updated_at = ${input.now}
              WHERE state = 'delivering' AND destination_kind NOT IN ('goat', 'mcp')
              RETURNING delivery_id, input_id, task_id, kind, destination_kind, message_json,
                last_error_code, operation
            `;
            yield* copyUndeliveredReplies(sql, interrupted, "ambiguous", input.now);
          }),
        )
        .pipe(
          Effect.tap(() => changed),
          Effect.mapError(mapError("settleInterruptedDeliveries")),
        ),
    releaseUnsentDeliveries: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* fence(input.owner);
            const queries = unsentDeliveryQueries(sql, {
              before: input.before,
              exclude: encodeIds(input.exclude),
              limit: input.limit,
            });
            // The rule restart recovery uses for a row never handed over. The row keeps its place,
            // so the claim's earlier-row rule still holds the task's later rows behind it.
            const released = yield* sql<{ readonly delivery_id: string }>`
              UPDATE channel_outbox SET state = 'pending', updated_at = ${input.now}
              WHERE delivery_id IN (${queries.selection})
              RETURNING delivery_id`;
            const [left] = yield* sql<{ readonly waiting: number }>`${queries.remaining}`;
            return { released: released.length, remaining: left?.waiting === 1 };
          }),
        )
        .pipe(Effect.mapError(mapError("releaseUnsentDeliveries"))),
    recordDelivery: (input) =>
      expiring((expire) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              yield* fence(input.owner);
              yield* expire(input.now);
              const outcome = input.outcome;
              const updated = yield* sql<UndeliveredSourceRow>`UPDATE channel_outbox SET
        state = ${outcome.type === "retry" ? "pending" : outcome.type},
        next_attempt_at = ${outcome.type === "retry" ? outcome.at : input.now},
        last_error_code = ${outcome.type === "delivered" ? null : outcome.errorCode},
        external_message_id = ${outcome.type === "delivered" ? (outcome.externalMessageId ?? null) : null},
        updated_at = ${input.now}
        WHERE delivery_id = ${input.deliveryId} AND state = 'delivering'
          AND (${input.attempt ?? null} IS NULL OR attempts = ${input.attempt ?? null})
        RETURNING delivery_id, input_id, task_id, kind, destination_kind, message_json, last_error_code,
          operation`;
              const recorded = updated[0];
              if (
                recorded !== undefined &&
                (outcome.type === "failed" || outcome.type === "ambiguous")
              ) {
                yield* copyUndeliveredReply(sql, recorded, outcome.type, input.now);
              }
              if (recorded === undefined || outcome.type !== "delivered") return undefined;
              // The person can read a delivered post now; its unread commits with the settle.
              const message = yield* Effect.option(
                Effect.try(() => decodeOutbound(recorded.message_json)),
              );
              return Option.isNone(message)
                ? undefined
                : yield* raiseMessageMark(sql, message.value, recorded.operation, input.now);
            }),
          )
          .pipe(
            Effect.flatMap((owner) => (owner === undefined ? Effect.void : announce([owner]))),
            Effect.mapError(mapError("recordDelivery")),
          ),
      ),
  };
  return {
    markSending: Effect.fn("ChannelLedger.markSending")(operations.markSending),
    settleInterruptedDeliveries: Effect.fn("ChannelLedger.settleInterruptedDeliveries")(
      operations.settleInterruptedDeliveries,
    ),
    releaseUnsentDeliveries: Effect.fn("ChannelLedger.releaseUnsentDeliveries")(
      operations.releaseUnsentDeliveries,
      Effect.tap((result) => (result.released > 0 ? changed : Effect.void)),
    ),
    expireReceipts: Effect.fn("ChannelLedger.expireReceipts")(
      operations.expireReceipts,
      Effect.tap(() => changed),
    ),
    claimDueDeliveries: Effect.fn("ChannelLedger.claimDueDeliveries")(
      operations.claimDueDeliveries,
      Effect.tap(() => changed),
    ),
    claimDue: Effect.fn("ChannelLedger.claimDue")(
      operations.claimDue,
      Effect.tap(() => changed),
    ),
    recordDelivery: Effect.fn("ChannelLedger.recordDelivery")(
      operations.recordDelivery,
      Effect.tap(() => changed),
    ),
  };
};
