import { ChannelOutboundMessage, type ChannelDeliveryId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import type { SqlError } from "effect/sql/SqlError";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import type { ChannelLedger } from "./ChannelLedger.ts";
import { ChannelLedgerError } from "./channelLedgerError.ts";

const decodeOutbound = Schema.decodeUnknownSync(Schema.fromJsonString(ChannelOutboundMessage));
const isLedgerError = Schema.is(ChannelLedgerError);
const mapError = (detail: string) => (cause: unknown) =>
  isLedgerError(cause) ? cause : new ChannelLedgerError({ reason: "persistence", detail, cause });

export const deliveryLedger = (
  sql: SqlClient.SqlClient,
  fence: (owner: string | undefined) => Effect.Effect<void, SqlError | ChannelLedgerError>,
  changed: Effect.Effect<void>,
  expired: Effect.Effect<void>,
): Pick<ChannelLedger["Service"], "claimDueDeliveries" | "recordDelivery" | "expireReceipts"> => {
  const expireRows = (now: string) => sql<{
    readonly delivery_id: string;
  }>`UPDATE channel_outbox SET
    state = CASE WHEN state = 'delivering' THEN 'ambiguous' ELSE 'failed' END,
    last_error_code = 'receipt_deadline', updated_at = ${now}
    WHERE state IN ('pending', 'delivering') AND EXISTS (
      SELECT 1 FROM channel_inbox i WHERE channel_outbox.cause_key = 'reply:' || i.input_id
        AND i.accepted_at <= ${DateTime.formatIso(DateTime.makeUnsafe(Date.parse(now) - 60_000))})
    RETURNING delivery_id`;
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
    claimDueDeliveries: (input) =>
      expiring((expire) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              yield* fence(input.owner);
              yield* expire(input.now);
              const rows = yield* sql<{
                readonly row_order: number;
                readonly delivery_id: ChannelDeliveryId;
                readonly message_json: string;
                readonly attempts: number;
                readonly cause_key: string;
                readonly input_id: string | null;
              }>`UPDATE channel_outbox SET state = 'delivering', attempts = attempts + 1,
        updated_at = ${input.now}
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
                  AND earlier.state IN ('pending', 'delivering') AND earlier.rowid < due.rowid)))
          ORDER BY CASE WHEN due.cause_key = 'reply:' || due.input_id THEN 0 ELSE 1 END,
            due.created_at, due.rowid LIMIT ${input.limit})
        RETURNING rowid AS row_order, delivery_id, message_json, attempts, cause_key, input_id`;
              return yield* Effect.forEach(
                rows.toSorted((a, b) => {
                  const aReceipt = a.cause_key === "reply:" + a.input_id;
                  const bReceipt = b.cause_key === "reply:" + b.input_id;
                  return Number(bReceipt) - Number(aReceipt) || a.row_order - b.row_order;
                }),
                (row) =>
                  Effect.gen(function* () {
                    const receipt =
                      row.input_id !== null && row.cause_key === "reply:" + row.input_id;
                    const inbox = receipt
                      ? yield* sql<{ readonly accepted_at: string }>`
          SELECT accepted_at FROM channel_inbox WHERE input_id = ${row.input_id}`
                      : [];
                    return {
                      deliveryId: row.delivery_id,
                      message: decodeOutbound(row.message_json),
                      attempts: row.attempts,
                      ...(inbox[0] === undefined
                        ? {}
                        : { receiptDeadline: Date.parse(inbox[0].accepted_at) + 60_000 }),
                    };
                  }),
              );
            }),
          )
          .pipe(Effect.mapError(mapError("claimDueDeliveries"))),
      ),
    recordDelivery: (input) =>
      expiring((expire) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              yield* fence(input.owner);
              yield* expire(input.now);
              const outcome = input.outcome;
              yield* sql`UPDATE channel_outbox SET
        state = ${outcome.type === "retry" ? "pending" : outcome.type},
        next_attempt_at = ${outcome.type === "retry" ? outcome.at : input.now},
        last_error_code = ${outcome.type === "delivered" ? null : outcome.errorCode},
        external_message_id = ${outcome.type === "delivered" ? (outcome.externalMessageId ?? null) : null},
        updated_at = ${input.now}
        WHERE delivery_id = ${input.deliveryId} AND state = 'delivering'
          AND (${input.attempt ?? null} IS NULL OR attempts = ${input.attempt ?? null})`;
            }),
          )
          .pipe(Effect.mapError(mapError("recordDelivery"))),
      ),
  };
  return {
    expireReceipts: Effect.fn("ChannelLedger.expireReceipts")(
      operations.expireReceipts,
      Effect.tap(() => changed),
    ),
    claimDueDeliveries: Effect.fn("ChannelLedger.claimDueDeliveries")(
      operations.claimDueDeliveries,
      Effect.tap(() => changed),
    ),
    recordDelivery: Effect.fn("ChannelLedger.recordDelivery")(
      operations.recordDelivery,
      Effect.tap(() => changed),
    ),
  };
};
