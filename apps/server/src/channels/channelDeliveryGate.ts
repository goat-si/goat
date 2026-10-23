/**
 * channelDeliveryGate - has an input's acknowledgement finished reaching the person?
 *
 * The reply rides the outbox like any other delivery. Work it announced must not start while a
 * row for that input could still reach them (pending, or claimed and in flight): nobody's work
 * runs before they hear about it. The ledger owns outbox writes; this only reads the same rows.
 *
 * @module channelDeliveryGate
 */
import type { ChannelInputId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

/**
 * True while one of the input's deliveries may still reach the person. A failed read answers
 * false instead of wedging work that ran without any gate before this one existed.
 */
export const hasUnsettledChannelDelivery = (sql: SqlClient.SqlClient, inputId: ChannelInputId) =>
  sql`SELECT 1 AS unsettled FROM channel_outbox
      WHERE input_id = ${inputId} AND state IN ('pending', 'delivering') LIMIT 1`.pipe(
    Effect.map((rows) => rows.length > 0),
    Effect.catchCause((cause) =>
      Effect.logWarning("channel delivery gate read failed; dispatching anyway", {
        cause,
      }).pipe(Effect.as(false)),
    ),
  );
