import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Lets an outbox row edit or end a Slack message GOAT already sent instead of posting a new one.
 * Every existing row is a post; servers before this one read every row as a post.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE channel_outbox ADD COLUMN operation TEXT NOT NULL DEFAULT 'post'
    CHECK (operation IN ('post', 'edit', 'end'))`;
  yield* sql`ALTER TABLE channel_outbox ADD COLUMN target_delivery_id TEXT`;
  yield* sql`CREATE INDEX IF NOT EXISTS channel_outbox_target_idx
    ON channel_outbox(target_delivery_id) WHERE target_delivery_id IS NOT NULL`;
});
