import type { ChannelInputId, ChannelTaskId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

export const sessionClaim = (inputId: string) => "channel-session:" + inputId;
export const isSessionClaim = (id: string | undefined) =>
  id?.startsWith("channel-session:") === true || id?.startsWith("channel-session-ack:") === true;

export const sealedSessionLine = (text: string, streaming: boolean) => {
  const newline = text.indexOf("\n");
  if (newline < 0 && streaming) return undefined;
  const line = (newline < 0 ? text : text.slice(0, newline)).replace(/\r$/u, "");
  return line.trim() === "" ? undefined : line;
};

export const sessionFinalText = Effect.fn("channel.sessionFinalText")(function* (
  sql: SqlClient.SqlClient,
  taskId: ChannelTaskId,
  turnItemId: string | undefined,
  text: string,
) {
  const rows = yield* sql<{
    readonly source: string;
    readonly turn_item_id: string | null;
    readonly text: string;
  }>`
    SELECT source, turn_item_id, text FROM channel_session_receipts WHERE task_id = ${taskId}`;
  const receipt = rows[0];
  return receipt?.source === "session" &&
    turnItemId !== undefined &&
    receipt.turn_item_id === turnItemId &&
    text.startsWith(receipt.text)
    ? text.slice(receipt.text.length).trim()
    : text.trim();
});

/** Whether the input still holds a session claim with no committed receipt; unreadable counts as pending. */
export const sessionReceiptPending = Effect.fn("channel.sessionReceiptPending")(
  function* (sql: SqlClient.SqlClient, inputId: ChannelInputId) {
    const rows = yield* sql`SELECT 1 FROM channel_inbox i WHERE i.input_id = ${inputId}
      AND i.state = 'processing'
      AND (i.reception_id LIKE 'channel-session:%' OR i.reception_id LIKE 'channel-session-ack:%')
      AND NOT EXISTS (SELECT 1 FROM channel_session_receipts r WHERE r.input_id = ${inputId})`;
    return rows.length > 0;
  },
  Effect.orElseSucceed(() => true),
);
