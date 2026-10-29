import type { ChannelInputId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

export const isReceiptSettlement = (state: string | undefined) =>
  state === "delivered" || state === "failed" || state === "ambiguous";

export const readReceiptSettlement = Effect.fn("channel.readReceiptSettlement")(
  function* (sql: SqlClient.SqlClient, inputId: ChannelInputId) {
    const rows = yield* sql<{ readonly state: string }>`SELECT state FROM channel_outbox
    WHERE cause_key = ${"reply:" + inputId}`;
    return isReceiptSettlement(rows[0]?.state);
  },
  Effect.orElseSucceed(() => false),
);
