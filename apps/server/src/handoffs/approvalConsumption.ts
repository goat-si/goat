import { OrchestratorMcpFailure } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

const unavailable = () =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: "The approval record is unavailable.",
  });

/**
 * Marks an approval used before the change it approves starts. The primary key makes a second
 * use fail at insert, so two concurrent calls with one approval admit exactly one.
 */
export const consumeApproval = Effect.fn("ApprovalConsumption.consume")(function* (
  approvalId: string,
  action: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const time = DateTime.formatIso(yield* DateTime.now);
  const inserted = yield* sql<{ readonly approval_id: string }>`
    INSERT INTO approval_consumptions (approval_id, action, consumed_at)
    VALUES (${approvalId}, ${action}, ${time})
    ON CONFLICT (approval_id) DO NOTHING
    RETURNING approval_id`.pipe(Effect.mapError(unavailable));
  if (inserted.length === 0)
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "That approval was already used.",
    });
});

/** Whether the change an approval covers already happened once. */
export const approvalUsed = Effect.fn("ApprovalConsumption.used")(function* (approvalId: string) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly found: number }>`
    SELECT 1 AS found FROM approval_consumptions WHERE approval_id = ${approvalId}`.pipe(
    Effect.mapError(unavailable),
  );
  return rows.length > 0;
});

/**
 * Marks an approval used after the change it approves happened (D3: an approval lasts until its
 * change succeeds once). The caller serializes the change, so a repeat here is the same success.
 */
export const markApprovalUsed = Effect.fn("ApprovalConsumption.markUsed")(function* (
  approvalId: string,
  action: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const time = DateTime.formatIso(yield* DateTime.now);
  yield* sql`
    INSERT INTO approval_consumptions (approval_id, action, consumed_at)
    VALUES (${approvalId}, ${action}, ${time})
    ON CONFLICT (approval_id) DO NOTHING`.pipe(Effect.mapError(unavailable));
});
