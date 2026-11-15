/**
 * The recent runs a GOAT Bot routine's list entry carries: one windowed read for every chosen
 * routine, with the bot input each run spoke through and whether the bot answered "no update".
 */
import {
  ChannelInputId,
  SCHEDULED_TASK_RECENT_RUN_BYTES,
  SCHEDULED_TASK_RECENT_RUN_ROUTINES,
  SCHEDULED_TASK_RECENT_RUNS,
  ScheduledTaskRun,
  type ScheduledTask,
  ScheduledTaskRecentRun,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

interface RecentRunRow {
  readonly task_id: string;
  readonly snapshot_json: string;
  readonly input_id: string | null;
  readonly quiet: number | null;
}

const decodeSnapshot = Schema.decodeUnknownOption(Schema.fromJsonString(ScheduledTaskRun));
const decodeInputId = Schema.decodeUnknownOption(ChannelInputId);
const encodeHistory = Schema.encodeUnknownOption(
  Schema.fromJsonString(Schema.Array(ScheduledTaskRecentRun)),
);
/** `,"recentRuns":` around each routine's encoded history. */
const KEY_BYTES = 14;

/** The bytes a routine's history adds to the encoded list, exactly as the wire encodes it. */
function historyBytes(runs: ReadonlyArray<ScheduledTaskRecentRun>): number {
  const json = encodeHistory(runs);
  return Option.isSome(json) ? KEY_BYTES + Buffer.byteLength(json.value) : Infinity;
}
const encodeChosen = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Array(Schema.Tuple([Schema.String, Schema.String]))),
);

function recentRun(row: RecentRunRow): ScheduledTaskRecentRun | undefined {
  const snapshot = decodeSnapshot(row.snapshot_json);
  if (Option.isNone(snapshot)) return undefined;
  const run = snapshot.value;
  const inputId = decodeInputId(row.input_id);
  return {
    firingId: run.firingId,
    status: run.status,
    requestedAt: run.requestedAt,
    completedAt: run.completedAt,
    ...(run.dispatchStatus === "accepted" && run.threadId !== null && Option.isSome(inputId)
      ? { conversation: { threadId: run.threadId, inputId: inputId.value } }
      : {}),
    ...(run.status === "completed" && row.quiet === 1 ? { quiet: true as const } : {}),
  };
}

/** Each routine's newest runs, newest first; a run whose snapshot cannot be read is left out. */
export const readRecentRuns = Effect.fn("ScheduledTaskRecentRuns.read")(function* (
  sql: SqlClient.SqlClient,
  routines: ReadonlyArray<Pick<ScheduledTask, "id" | "createdAt">>,
) {
  const chosen = yield* encodeChosen(routines.map((routine) => [routine.id, routine.createdAt]));
  const rows = yield* sql<RecentRunRow>`
    WITH chosen AS (SELECT json_extract(value, '$[0]') AS task_id, json_extract(value, '$[1]') AS created_at
      FROM json_each(${chosen}))
    SELECT task_id, snapshot_json, input_id, quiet FROM (
      SELECT r.task_id, r.snapshot_json, l.input_id,
        CASE WHEN json_valid(i.decision_json) THEN json_extract(i.decision_json, '$.action.type') END
          = 'no_update' AS quiet,
        ROW_NUMBER() OVER (PARTITION BY r.task_id, r.task_created_at
          ORDER BY r.requested_at DESC, r.firing_id DESC) AS position
      FROM chosen c
      JOIN scheduled_task_runs r ON r.task_id = c.task_id AND r.task_created_at = c.created_at
      LEFT JOIN scheduled_task_channel_inputs l ON l.firing_id = r.firing_id
      LEFT JOIN channel_inbox i ON i.input_id = l.input_id)
    WHERE position <= ${SCHEDULED_TASK_RECENT_RUNS} ORDER BY task_id, position`;
  const byTask = new Map<string, Array<ScheduledTaskRecentRun>>();
  for (const row of rows) {
    const run = recentRun(row);
    if (run === undefined) {
      yield* Effect.logWarning("Skipped a routine run that could not be read", {
        taskId: row.task_id,
      });
      continue;
    }
    byTask.set(row.task_id, [...(byTask.get(row.task_id) ?? []), run]);
  }
  return byTask;
});

/**
 * Gives GOAT Bot routines, in list order, their recent runs: at most
 * SCHEDULED_TASK_RECENT_RUN_ROUTINES of them, stopping before the history would pass
 * SCHEDULED_TASK_RECENT_RUN_BYTES. Later routines and other tasks get no key, and so does every
 * task when the read fails.
 */
export const withRecentRuns = Effect.fn("ScheduledTaskRecentRuns.attach")(function* (
  sql: SqlClient.SqlClient,
  tasks: ReadonlyArray<ScheduledTask>,
) {
  const chosen = tasks
    .filter((task) => task.goatBotRoutine === true)
    .slice(0, SCHEDULED_TASK_RECENT_RUN_ROUTINES);
  if (chosen.length === 0) return tasks;
  const byTask = yield* readRecentRuns(sql, chosen).pipe(
    Effect.asSome,
    Effect.catch((cause) =>
      Effect.logWarning("Could not read routine run history", { cause }).pipe(
        Effect.as(Option.none<Map<string, Array<ScheduledTaskRecentRun>>>()),
      ),
    ),
  );
  if (Option.isNone(byTask)) return tasks;
  const carried = new Map<string, ReadonlyArray<ScheduledTaskRecentRun>>();
  let budget = SCHEDULED_TASK_RECENT_RUN_BYTES;
  for (const task of chosen) {
    const runs = byTask.value.get(task.id) ?? [];
    const bytes = historyBytes(runs);
    if (bytes > budget) break;
    budget -= bytes;
    carried.set(task.id, runs);
  }
  return tasks.map((task) => {
    const recentRuns = carried.get(task.id);
    return recentRuns === undefined ? task : { ...task, recentRuns };
  });
});
