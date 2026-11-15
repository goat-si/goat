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
 * The most bytes one stored run may return to the server: snapshot plus input id, counted over the
 * whole value, NULs included. A run this server writes is about 430. A routine with a larger run
 * carries no history, so at most 350 of these reach the server. octet_length reads the size from the
 * record header, so SQLite never loads an oversized value.
 */
const MAX_STORED_RUN_BYTES = 1024;

/**
 * The longest routine task id, in bytes, the history read takes. Generated ids are under 100 bytes
 * (`goat-bot-check-in:` and a bot thread id, or `scheduled-task:` and a UUID), but a caller's
 * `commandId` or chosen id has no length limit. A routine over it is not read and has no history.
 */
const MAX_ROUTINE_ID_BYTES = 256;
/** Creation times are 24-byte ISO strings the server writes; a stored one over this is not read. */
const MAX_CREATED_AT_BYTES = 64;
/**
 * A quiet routine decision is always the fixed `{"replyText":"No update.","action":{"type":"no_update"}}`
 * (56 bytes), so a larger stored decision is never quiet: it is not parsed, and its run shows its
 * plain outcome.
 */
const MAX_QUIET_DECISION_BYTES = 512;

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
// Input ids are `channel-input:` and base64url. A stored one outside printable ASCII, a quote or a
// backslash gets no conversation, so its encoded JSON is never larger than its stored bytes.
const PLAIN_INPUT_ID = /^[!#-[\]-~]+$/u;
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
  const inputId = Option.filter(decodeInputId(row.input_id), (id) => PLAIN_INPUT_ID.test(id));
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
 * routines with a stored run over MAX_STORED_RUN_BYTES come back in `oversized`, without runs.
 */
export const readRecentRuns = Effect.fn("ScheduledTaskRecentRuns.read")(function* (
  sql: SqlClient.SqlClient,
  routines: ReadonlyArray<Pick<ScheduledTask, "id" | "createdAt">>,
) {
  const chosen = yield* encodeChosen(routines.map((routine) => [routine.id, routine.createdAt]));
  // Per routine, seven steps down scheduled_task_runs_task, however many firings it has stored.
  // Each size guard is a CASE branch beside the column it reads, so no plan loads a value before
  // its check: SQLite evaluates CASE lazily (sqlite.org/lang_expr.html).
  const rows = yield* sql<RecentRunRow>`
    WITH chosen(task_id, created_at) AS (
      SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(${chosen}))
    SELECT c.task_id,
      CASE WHEN octet_length(r.snapshot_json) + coalesce(octet_length(l.input_id), 0)
        <= ${MAX_STORED_RUN_BYTES} THEN r.snapshot_json END AS snapshot_json,
      CASE WHEN octet_length(r.snapshot_json) + coalesce(octet_length(l.input_id), 0)
        <= ${MAX_STORED_RUN_BYTES} THEN l.input_id END AS input_id,
      CASE WHEN octet_length(i.decision_json) <= ${MAX_QUIET_DECISION_BYTES} THEN
        CASE WHEN json_valid(i.decision_json) THEN json_extract(i.decision_json, '$.action.type') END
      END = 'no_update' AS quiet,
      octet_length(r.snapshot_json) + coalesce(octet_length(l.input_id), 0) > ${MAX_STORED_RUN_BYTES}
        AS oversized
    FROM chosen c
    JOIN scheduled_task_runs r ON r.firing_id IN (
      SELECT n.firing_id FROM scheduled_task_runs n
      WHERE n.task_id = c.task_id AND n.task_created_at = c.created_at
      ORDER BY n.requested_at DESC, n.firing_id DESC LIMIT ${SCHEDULED_TASK_RECENT_RUNS})
    LEFT JOIN scheduled_task_channel_inputs l ON l.firing_id = r.firing_id
    LEFT JOIN channel_inbox i ON i.input_id =
      CASE WHEN octet_length(l.input_id) <= ${MAX_STORED_RUN_BYTES} THEN l.input_id END
    ORDER BY c.task_id, r.requested_at DESC, r.firing_id DESC`;
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
