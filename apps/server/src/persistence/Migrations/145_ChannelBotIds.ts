import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Every row stored before member bots belongs to the main bot. Older builds keep this column on
// the rows they update; tasks they create take the default and are repaired at startup.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE channel_inbox ADD COLUMN bot_id TEXT NOT NULL DEFAULT 'main'`;
  yield* sql`ALTER TABLE channel_tasks ADD COLUMN bot_id TEXT NOT NULL DEFAULT 'main'`;
  yield* sql`CREATE INDEX IF NOT EXISTS channel_tasks_owner_bot_status
    ON channel_tasks(owner_id, bot_id, status)`;
  yield* sql`CREATE INDEX IF NOT EXISTS channel_inbox_member_bot
    ON channel_inbox(bot_id) WHERE bot_id <> 'main'`;
});
