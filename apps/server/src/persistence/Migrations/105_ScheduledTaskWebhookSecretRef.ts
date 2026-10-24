import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The secretRef that set a webhook task's signing secret, null for a secret given inline. A ref is
 * consumed by the save that stores it, so this is how an update whose result was lost tells
 * whether its rotation was saved.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN webhook_secret_ref TEXT`;
});
