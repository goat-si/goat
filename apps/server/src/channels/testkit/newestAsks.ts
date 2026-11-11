import { ChannelTask } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { newestAskAt } from "../channelWaitingTasks.ts";

const decodeTask = Schema.decodeUnknownSync(Schema.fromJsonString(ChannelTask));

/** Keeps `newest_ask_at` in step after a test rewrote task_json with SQL, as the ledger does. */
export const syncNewestAsks = Effect.fn("syncNewestAsks")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly task_id: string; readonly task_json: string }>`
    SELECT task_id, task_json FROM channel_tasks`;
  for (const row of rows) {
    yield* sql`UPDATE channel_tasks SET newest_ask_at = ${newestAskAt(decodeTask(row.task_json))}
      WHERE task_id = ${row.task_id}`;
  }
});
