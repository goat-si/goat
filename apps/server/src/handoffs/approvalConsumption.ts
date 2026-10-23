import { OrchestratorMcpFailure } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

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
    RETURNING approval_id`.pipe(
    Effect.mapError(
      () =>
        new OrchestratorMcpFailure({
          code: "orchestration_error",
          message: "The approval record is unavailable.",
        }),
    ),
  );
  if (inserted.length === 0)
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "That approval was already used.",
    });
});
