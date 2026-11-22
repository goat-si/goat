import type { BotProfile } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { ChannelLedger } from "./ChannelLedger.ts";
import { prepareTransition } from "./channelTaskWrites.ts";

export const stopForBotToolsChange = Effect.fn("ChannelBotTools.stopRunning")(function* (
  sql: SqlClient.SqlClient,
  ledger: ChannelLedger["Service"],
  ownerId: string,
  bot: BotProfile,
  at: string,
) {
  const botRef = yield* ledger.getBotById(ownerId, bot.botId);
  let cursor: string | undefined;
  do {
    const page = yield* ledger.listTasks({
      ownerId,
      botId: bot.botId,
      statuses: ["dispatching", "running", "waiting_input"],
      limit: 100,
      cursor,
    });
    for (const task of page.tasks) {
      const stored = yield* ledger.getTask(task.taskId);
      if (stored === undefined) continue;
      const prepared = prepareTransition(
        stored,
        {
          type: "task.cancelled",
          payload: { reason: `Stopped: ${bot.name}'s tools changed` },
        },
        at,
        botRef?.bot,
        { actor: "system", narrate: true, forward: true },
      );
      if (prepared.ok)
        yield* ledger.applyTaskEvent({ write: prepared.write, deliveries: prepared.deliveries });
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined);

  yield* sql`
      UPDATE channel_bot_sessions SET state = 'retired', retired_at = ${at}, version = version + 1
      WHERE state IN ('starting', 'active') AND task_id IN (
        SELECT task_id FROM channel_tasks WHERE owner_id = ${ownerId} AND bot_id = ${bot.botId}
      )
    `;
});
