/**
 * The recent runs a GOAT Bot routine's list entry carries: one windowed read for every chosen
 * routine, with the bot input each run spoke through and whether the bot answered "no update".
 */
import {
  ChannelInputId,
  SCHEDULED_TASK_RECENT_RUN_BYTES,
  SCHEDULED_TASK_RECENT_RUN_ROUTINES,
  SCHEDULED_TASK_RECENT_RUNS,
  CommandId,
  IsoDateTime,
  ThreadId,
  type ScheduledTask,
  ScheduledTaskRecentRun,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

interface RecentRunRow {
  readonly task_id: string;
  readonly snapshot_json: string | null;
  readonly input_id: string | null;
  readonly quiet: number | null;
  readonly oversized: number;
}

/**
 * The most characters one stored run may return to the server: its snapshot plus its input id. A
 * run this server writes is about 430; task ids have no length limit, and every firing id repeats
 * one. A routine with a larger run carries no history, so at most 350 of these (plus each row's task
 * id) reach the server; SQLite still reads an oversized value to measure it.
 */
export const MAX_STORED_RUN_CHARS = 1024;

/**
 * The longest routine task id, in bytes, the history read takes. Ids this server creates for a
 * routine are under 100 bytes (`goat-bot-check-in:` and a bot thread id, or `scheduled-task:` and a
 * UUID), but ids are not limited at creation. A routine over it is not read and carries no history.
 */
export const MAX_ROUTINE_ID_BYTES = 256;
/** Creation times are 24-byte ISO strings the server writes; a stored one over this is not read. */
const MAX_CREATED_AT_BYTES = 64;

const readable = (task: Pick<ScheduledTask, "id" | "createdAt">) =>
  Buffer.byteLength(task.id) <= MAX_ROUTINE_ID_BYTES &&
  Buffer.byteLength(task.createdAt) <= MAX_CREATED_AT_BYTES;

// Only the fields the history sends, with any status, so an older firing a later server stored
// stays. The latest firing is still decoded strictly by list() as lastRun, as before.
const StoredRun = Schema.Struct({
  firingId: CommandId,
  dispatchStatus: Schema.String,
  status: Schema.String,
  threadId: Schema.NullOr(ThreadId),
  requestedAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
});
const decodeSnapshot = Schema.decodeUnknownOption(Schema.fromJsonString(StoredRun));
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
  if (row.snapshot_json === null) return undefined;
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
    ...(run.dispatchStatus === "failed" ? { dispatchFailed: true as const } : {}),
  };
}

/**
 * Each routine's newest runs, newest first; a run whose snapshot cannot be read is left out. The
 * routines with a stored run over MAX_STORED_RUN_CHARS come back in `oversized`, without runs.
 */
export const readRecentRuns = Effect.fn("ScheduledTaskRecentRuns.read")(function* (
  sql: SqlClient.SqlClient,
  routines: ReadonlyArray<Pick<ScheduledTask, "id" | "createdAt">>,
) {
  const chosen = yield* encodeChosen(routines.map((routine) => [routine.id, routine.createdAt]));
  // Per routine, seven steps down scheduled_task_runs_task, however many firings it has stored.
  const rows = yield* sql<RecentRunRow>`
    WITH chosen(task_id, created_at) AS (
      SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(${chosen}))
    SELECT task_id, CASE WHEN NOT oversized THEN snapshot_json END AS snapshot_json,
      CASE WHEN NOT oversized THEN input_id END AS input_id, quiet, oversized FROM (
      SELECT c.task_id, r.snapshot_json, l.input_id, r.requested_at, r.firing_id,
        length(r.snapshot_json) + coalesce(length(l.input_id), 0) > ${MAX_STORED_RUN_CHARS} AS oversized,
        CASE WHEN json_valid(i.decision_json) THEN json_extract(i.decision_json, '$.action.type') END
          = 'no_update' AS quiet
      FROM chosen c
      JOIN scheduled_task_runs r ON r.firing_id IN (
        SELECT n.firing_id FROM scheduled_task_runs n
        WHERE n.task_id = c.task_id AND n.task_created_at = c.created_at
        ORDER BY n.requested_at DESC, n.firing_id DESC LIMIT ${SCHEDULED_TASK_RECENT_RUNS})
      LEFT JOIN scheduled_task_channel_inputs l ON l.firing_id = r.firing_id
      LEFT JOIN channel_inbox i ON i.input_id = l.input_id)
    ORDER BY task_id, requested_at DESC, firing_id DESC`;
  const byTask = new Map<string, Array<ScheduledTaskRecentRun>>();
  const oversized = new Set<string>();
  for (const row of rows) {
    if (row.oversized === 1) {
      oversized.add(row.task_id);
      continue;
    }
    const run = recentRun(row);
    if (run === undefined) {
      yield* Effect.logWarning("Skipped a routine run that could not be read", {
        taskId: row.task_id,
      });
      continue;
    }
    byTask.set(row.task_id, [...(byTask.get(row.task_id) ?? []), run]);
  }
  for (const taskId of oversized) byTask.delete(taskId);
  return { byTask, oversized };
});

/**
 * Gives up to 50 GOAT Bot routines, in list order, their recent runs, stopping before the history
 * passes its byte budget; later routines get no key, and every task does when the read fails. A
 * routine with an id over MAX_ROUTINE_ID_BYTES or an oversized stored run is skipped.
 */
export const withRecentRuns = Effect.fn("ScheduledTaskRecentRuns.attach")(function* (
  sql: SqlClient.SqlClient,
  tasks: ReadonlyArray<ScheduledTask>,
) {
  const routines = tasks
    .filter((task) => task.goatBotRoutine === true)
    .slice(0, SCHEDULED_TASK_RECENT_RUN_ROUTINES);
  // Bounds every id the query is given and returns: an id over the cap never reaches it.
  const chosen = routines.filter(readable);
  if (chosen.length === 0) return tasks;
  const byTask = yield* readRecentRuns(sql, chosen).pipe(
    Effect.asSome,
    Effect.catch((cause) =>
      Effect.logWarning("Could not read routine run history", { cause }).pipe(
        Effect.as(Option.none<Effect.Success<ReturnType<typeof readRecentRuns>>>()),
      ),
    ),
  );
  if (Option.isNone(byTask)) return tasks;
  const { byTask: runsByTask, oversized } = byTask.value;
  const carried = new Map<string, ReadonlyArray<ScheduledTaskRecentRun>>();
  let budget = SCHEDULED_TASK_RECENT_RUN_BYTES;
  for (const task of chosen) {
    if (oversized.has(task.id)) continue;
    const runs = runsByTask.get(task.id) ?? [];
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
