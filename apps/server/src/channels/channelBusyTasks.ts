import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import { ChannelLedgerError } from "./channelLedgerError.ts";

export const countBusyTasks = (
  sql: SqlClient.SqlClient,
  input: { readonly ownerId: string; readonly principalId: string },
) =>
  sql<{ readonly busy: number }>`
        SELECT COUNT(*) AS busy FROM channel_tasks
        WHERE owner_id = ${input.ownerId}
          AND json_extract(task_json, '$.requester.principalId') = ${input.principalId}
          AND NOT EXISTS (SELECT 1 FROM channel_inbox i
            WHERE i.input_id = json_extract(channel_tasks.task_json, '$.originInputId')
              AND (i.reception_id LIKE 'channel-session:%' OR i.reception_id LIKE 'channel-session-ack:%'))
          AND (status IN ('dispatching', 'running')
            OR (status = 'waiting_input' AND json_extract(task_json, '$.worker') IS NOT NULL)
            -- Stopped, but its worker may still run until the stop goes through.
            OR (status = 'cancelled' AND EXISTS (
              SELECT 1 FROM channel_task_events AS stop
              WHERE stop.task_id = channel_tasks.task_id AND stop.type = 'task.cancelled'
                AND stop.forward_state = 'pending'
            )))
      `.pipe(
    Effect.map((rows) => rows[0]?.busy ?? 0),
    Effect.mapError(
      (cause) => new ChannelLedgerError({ reason: "persistence", detail: "countBusyTasks", cause }),
    ),
  );
