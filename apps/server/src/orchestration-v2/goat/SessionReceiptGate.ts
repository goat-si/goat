import { ChannelInputId, type ChannelTaskId, type RunId, type ThreadId } from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { readReceiptSettlement } from "../../channels/channelReceiptSettlement.ts";

export type ReceiptOwnership = {
  readonly taskId: ChannelTaskId;
  readonly generation: number;
  readonly status: string;
  readonly activeAttemptId: string | null;
};
export type ReceiptState =
  | { readonly state: "absent" }
  | { readonly state: "invalid"; readonly discard?: boolean }
  | (ReceiptOwnership & { readonly state: "held" | "settled" });

export class SessionReceiptGate extends Context.Service<
  SessionReceiptGate,
  {
    readonly inspect: (threadId: ThreadId, runId: RunId) => Effect.Effect<ReceiptState>;
    readonly subscribe: Effect.Effect<Effect.Effect<void>, never, Scope.Scope>;
    readonly changed: Effect.Effect<void>;
  }
>()("goat/orchestration-v2/goat/SessionReceiptGate") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const changes = yield* PubSub.unbounded<void>();
  const inspect = Effect.fn("SessionReceiptGate.inspect")(
    function* (threadId: ThreadId, runId: RunId): Effect.fn.Return<ReceiptState, SqlError> {
      const roots = yield* sql<{
        readonly status: string;
        readonly active_attempt_id: string | null;
      }>`
      SELECT status, json_extract(payload_json, '$.activeAttemptId') AS active_attempt_id
      FROM orchestration_v2_projection_runs WHERE run_id = ${runId} AND thread_id = ${threadId}`;
      const root = roots[0];
      if (root === undefined) return { state: "invalid" };
      const intents = yield* sql<{
        readonly task_id: ChannelTaskId | null;
        readonly task_generation: number | null;
        readonly parent: string | null;
      }>`
      WITH RECURSIVE ancestry(run_id, message_id, payload, depth) AS (
        SELECT run_id, json_extract(payload_json, '$.userMessageId'), payload_json, 0
          FROM orchestration_v2_projection_runs WHERE run_id = ${runId} AND thread_id = ${threadId}
        UNION ALL
        SELECT r.run_id, json_extract(r.payload_json, '$.userMessageId'), r.payload_json, a.depth + 1
          FROM ancestry a LEFT JOIN orchestration_v2_projection_messages m ON m.message_id = a.message_id AND m.thread_id = ${threadId}
          JOIN orchestration_v2_projection_runs r ON r.thread_id = ${threadId} AND r.run_id = COALESCE(
            json_extract(m.payload_json, '$.delegatedCompletion.parentRunId'), json_extract(a.payload, '$.restartContinuationOfRunId'))
          WHERE a.depth < 31 AND NOT EXISTS (SELECT 1 FROM channel_bot_session_runs own
            WHERE own.thread_id = ${threadId} AND own.message_id = a.message_id)
      ) SELECT i.task_id, i.task_generation, COALESCE(json_extract(m.payload_json, '$.delegatedCompletion.parentRunId'),
        json_extract(a.payload, '$.restartContinuationOfRunId')) AS parent FROM ancestry a
        LEFT JOIN channel_bot_session_runs i ON i.thread_id = ${threadId} AND i.message_id = a.message_id
        LEFT JOIN orchestration_v2_projection_messages m ON m.thread_id = ${threadId} AND m.message_id = a.message_id ORDER BY a.depth`;
      const intent = intents.find((row) => row.task_id !== null);
      if (intent === undefined)
        return { state: intents.at(-1)?.parent == null ? "absent" : "invalid" };
      if (intent.task_id === null || intent.task_generation === null) return { state: "invalid" };
      const tasks = yield* sql<{
        readonly generation: number;
        readonly status: string;
        readonly input_id: string | null;
      }>`
      SELECT generation, status, json_extract(task_json, '$.originInputId') AS input_id
      FROM channel_tasks WHERE task_id = ${intent.task_id}`;
      const task = tasks[0];
      if (
        task === undefined ||
        task.generation !== intent.task_generation ||
        task.input_id === null ||
        task.status === "cancelled"
      )
        return {
          state: "invalid",
          discard:
            task !== undefined &&
            (task.generation !== intent.task_generation || task.status === "cancelled"),
        };
      return {
        state: (yield* readReceiptSettlement(sql, ChannelInputId.make(task.input_id)))
          ? "settled"
          : "held",
        taskId: intent.task_id,
        generation: intent.task_generation,
        status: root.status,
        activeAttemptId: root.active_attempt_id,
      };
    },
    Effect.catchCause(() => Effect.succeed<ReceiptState>({ state: "invalid" })),
  );
  return SessionReceiptGate.of({
    inspect,
    subscribe: PubSub.subscribe(changes).pipe(Effect.map(PubSub.take)),
    changed: PubSub.publish(changes, undefined).pipe(Effect.asVoid),
  });
});

export const layer = Layer.effect(SessionReceiptGate, make);
