/**
 * A drain's handling of an unreachable host: the row keeps when the outage began, retries leave
 * updated_at alone, and after OUTAGE_LOST_AFTER_MS tracking ends once (the origin is told, a task
 * gets its single result).
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import {
  committedTaskResult,
  RemoteTaskError,
  recordRemoteTaskResult,
  type TaskDispatch,
} from "./recordRemoteTaskResult.ts";
import type { RemoteDispatchRecord } from "./remoteDispatchModel.ts";
import { dispatchMonitorMessage } from "./remoteMonitorMessage.ts";

/**
 * Unreachable does not prove the machine stopped. Ending tracking releases the lane and channel
 * slot the work held, so the wait covers sleep, a reboot or a travel day before it gives up.
 */
const OUTAGE_LOST_AFTER_MS = 24 * 60 * 60_000;

/**
 * The longest wait between two failed contacts of one continuous watch: a 300 s backoff plus a
 * call of up to 6 minutes, with room to spare. A longer gap means this machine was asleep or
 * stopped, so that time is not the host's silence and the outage clock starts again.
 */
export const CONTACT_GAP_MS = 30 * 60_000;

const UNREACHABLE = new Set(["host_unavailable", "ssh_failed", "host_unknown"]);

/** No answer came back: the host was not reached, or this machine no longer knows how to reach it. */
export const isUnreachable = (error: unknown): boolean =>
  error instanceof SshRemoteDispatch.SshRemoteDispatchError && UNREACHABLE.has(error.reason);

const notAnswering = (host: string, since: string) => `${host} has not answered since ${since}.`;

const storage = (cause: unknown) => new RemoteTaskError({ stage: "storage", cause });
const delivery = (cause: unknown) => new RemoteTaskError({ stage: "delivery", cause });

const monitorMessage = Effect.fnUntraced(function* (input: {
  readonly key: string;
  readonly record: RemoteDispatchRecord;
  readonly text: string;
  readonly summary: string;
}) {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  yield* dispatchMonitorMessage(threads, { ...input, threadId: input.record.originThreadId }).pipe(
    Effect.mapError(delivery),
  );
});

/** The one early notice a task's origin gets when its host stops answering. */
export const notifyTaskOutage = (record: RemoteDispatchRecord) =>
  monitorMessage({
    key: `remote-task-outage:${record.correlationId}`,
    record,
    text: `GOAT cannot reach host ${record.host} to observe delegated task ${record.task?.taskId}. The task remains running; follow it with goat_call {path: "task.read", args: {taskId: "${record.task?.taskId}"}}.`,
    summary: `${record.host}: remote task host unavailable`,
  });

const endThread = Effect.fnUntraced(function* (
  record: RemoteDispatchRecord,
  since: string,
  at: string,
) {
  const sql = yield* SqlClient.SqlClient;
  // The notice goes first: a crash before the row changes leaves it running past the threshold,
  // and the next unreachable outcome sends again under the same command id.
  yield* monitorMessage({
    key: `remote-host-lost:${record.correlationId}:${since}`,
    record,
    text: `host_unavailable: ${notAnswering(record.host, since)} GOAT stopped following remote thread ${record.remoteThreadId} and released what it held for it; the thread may still be running there. If ${record.host} answers again, GOAT follows it again on its own. To stop following it for good, call goat_thread_unwatch with host "${record.host}" and threadId "${record.remoteThreadId}".`,
    summary: `${record.host}: not answering`,
  });
  yield* sql`UPDATE remote_dispatches SET state = 'lost', end_reason = 'host_unreachable',
    ended_at = ${at}, updated_at = ${at}, last_error = ${notAnswering(record.host, since)},
    observation = NULL
    WHERE correlation_id = ${record.correlationId} AND state = 'running'`.pipe(
    Effect.mapError(storage),
  );
  return true;
});

const endTask = Effect.fnUntraced(function* (
  record: RemoteDispatchRecord & TaskDispatch,
  since: string,
  at: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const summary = notAnswering(record.host, since);
  yield* recordRemoteTaskResult({ ...record, status: "failed", summary });
  const task = yield* committedTaskResult(record);
  if (task === null) return false;
  const ours = task.status === "failed" && task.result === summary;
  yield* sql`UPDATE remote_dispatches SET
    state = ${ours ? "lost" : task.status === "cancelled" ? "cancelled" : "settled"},
    end_reason = ${ours ? "host_unreachable" : null}, ended_at = ${ours ? at : null},
    known_run_status = ${task.status}, updated_at = ${at}, observation = NULL,
    last_error = ${ours ? summary : "Its result was already recorded before the host outage ended tracking."}
    WHERE correlation_id = ${record.correlationId} AND state = 'running'`.pipe(
    Effect.mapError(storage),
  );
  return true;
});

/**
 * Records one unreachable outcome for a running dispatch. True when the drain should stop: the
 * row is no longer running, or this outage reached OUTAGE_LOST_AFTER_MS and tracking ended.
 */
export const recordUnreachable = Effect.fn("remoteReports.recordUnreachable")(function* (
  record: RemoteDispatchRecord,
) {
  const sql = yield* SqlClient.SqlClient;
  const at = DateTime.formatIso(yield* DateTime.now);
  const atMs = Date.parse(at);
  const [current] = yield* sql<{ readonly since: string | null; readonly last: string | null }>`
    SELECT host_unavailable_since AS since, host_last_failed_at AS last FROM remote_dispatches
    WHERE correlation_id = ${record.correlationId} AND state = 'running'`.pipe(
    Effect.mapError(storage),
  );
  if (current === undefined) return true;
  // A gap restarts the clock, unless the outage had already run its course before the gap:
  // then tracking should have ended, and only a crash kept the row running.
  const began =
    current.since === null ||
    (current.last !== null &&
      atMs - Date.parse(current.last) > CONTACT_GAP_MS &&
      Date.parse(current.last) - Date.parse(current.since) < OUTAGE_LOST_AFTER_MS)
      ? at
      : current.since;
  const marked = yield* sql`UPDATE remote_dispatches SET host_unavailable_since = ${began},
    host_last_failed_at = ${at}, last_error = ${`Host unavailable since ${began}.`}
    WHERE correlation_id = ${record.correlationId} AND state = 'running'
    RETURNING correlation_id`.pipe(Effect.mapError(storage));
  if (marked.length === 0) return true;
  if (Date.parse(at) - Date.parse(began) < OUTAGE_LOST_AFTER_MS) return false;
  return record.task === null
    ? yield* endThread(record, began, at)
    : yield* endTask({ ...record, task: record.task }, began, at);
});

/**
 * Any answer, refusal or local failure other than an unreachable host ends the outage. True when
 * the row ends instead: this outage's failure was committed and a crash stopped the row change.
 */
export const clearUnreachable = Effect.fn("remoteReports.clearUnreachable")(function* (
  record: RemoteDispatchRecord,
) {
  const sql = yield* SqlClient.SqlClient;
  const since = record.hostUnavailableSince;
  if (record.task !== null && since !== null) {
    const summary = notAnswering(record.host, since);
    const task = yield* committedTaskResult({ ...record, task: record.task });
    if (task?.status === "failed" && task.result === summary) {
      const at = DateTime.formatIso(yield* DateTime.now);
      yield* sql`UPDATE remote_dispatches SET state = 'lost', end_reason = 'host_unreachable',
        ended_at = ${at}, updated_at = ${at}, known_run_status = 'failed', observation = NULL,
        last_error = ${summary}
        WHERE correlation_id = ${record.correlationId} AND state = 'running'`.pipe(
        Effect.mapError(storage),
      );
      return true;
    }
  }
  yield* sql`UPDATE remote_dispatches SET host_unavailable_since = NULL, host_last_failed_at = NULL
    WHERE correlation_id = ${record.correlationId} AND state = 'running'
      AND host_unavailable_since IS NOT NULL`.pipe(Effect.mapError(storage));
  return false;
});
