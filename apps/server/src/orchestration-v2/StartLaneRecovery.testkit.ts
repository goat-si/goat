import type { ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export const markStartClaimed = Effect.fn("test.markStartClaimed")(function* (threadId: ThreadId) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE orchestration_v2_effect_outbox
    SET status = 'running', attempt_count = 1, lease_owner = 'lost-process'
    WHERE thread_id = ${threadId} AND effect_type = 'provider-turn.start' AND status = 'pending'`;
});
