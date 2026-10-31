import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

let sequence = 0;

export const historyStamp = (recordedAt: number) => ({ recordedAt, orderSeq: ++sequence });
export type HistoryStamp = ReturnType<typeof historyStamp>;

export const initializeHistorySequence = Effect.fn("ComputerUseHistory.initializeSequence")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      readonly maximum: number;
    }>`SELECT COALESCE(MAX(order_seq), 0) AS maximum FROM computer_use_input_history`;
    sequence = Math.max(sequence, rows[0]?.maximum ?? 0);
  },
);
