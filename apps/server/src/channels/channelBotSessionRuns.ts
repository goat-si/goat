/**
 * Which task a GOAT Bot session run serves: the task its own message was recorded for before the
 * send, or for a delegated completion or restart continuation, the task of the run it continues.
 */
import {
  type ChannelTask,
  type ChannelTaskId,
  type MessageId,
  isGoatBotSessionThreadId,
  type OrchestrationV2Run,
  type RunId,
  type ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

const TERMINAL_RUN = new Set(["completed", "failed", "cancelled", "interrupted", "rolled_back"]);
export const isTerminalRun = (run: Pick<OrchestrationV2Run, "status">) =>
  TERMINAL_RUN.has(run.status);

export interface SessionIntent {
  readonly thread_id: ThreadId;
  readonly message_id: string;
  readonly task_id: ChannelTaskId;
  readonly task_generation: number;
  readonly kind: "launch" | "task" | "followup";
  readonly run_id: RunId | null;
  readonly steered_into_run_id: RunId | null;
}

type Records = {
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly messages: ReadonlyArray<{
    readonly id: string;
    readonly delegatedCompletion?: { readonly parentRunId: RunId } | undefined;
  }>;
};

/** The intent row a message was recorded under, if GOAT sent it into a session. */
const sessionIntentFor = (sql: SqlClient.SqlClient, threadId: string, messageId: string) =>
  sql<SessionIntent>`
    SELECT * FROM channel_bot_session_runs WHERE thread_id = ${threadId} AND message_id = ${messageId}
  `.pipe(Effect.map((rows) => rows[0]));

/**
 * The task a session run serves: the intent its own message was sent under, or for a delegated
 * completion or restart continuation, the run it continues. Undefined when GOAT never sent it.
 */
export const resolveSessionRun = Effect.fn("ChannelBotSession.resolveSessionRun")(function* (
  sql: SqlClient.SqlClient,
  threadId: string,
  records: Records,
  runId: string,
) {
  let run = records.runs.find((candidate) => candidate.id === runId);
  for (let hops = 0; run !== undefined && hops < 32; hops += 1) {
    const current: OrchestrationV2Run = run;
    const intent = yield* sessionIntentFor(sql, threadId, current.userMessageId);
    if (intent !== undefined) return intent;
    const message = records.messages.find((candidate) => candidate.id === current.userMessageId);
    const parent = message?.delegatedCompletion?.parentRunId ?? current.restartContinuationOfRunId;
    if (parent === undefined || parent === null) return undefined;
    run = records.runs.find((candidate) => candidate.id === parent);
  }
  return undefined;
});

/** Every run on the session that serves this task generation, oldest first. */
export const sessionTaskRuns = Effect.fn("ChannelBotSession.sessionTaskRuns")(function* (
  sql: SqlClient.SqlClient,
  threadId: string,
  records: Records,
  task: Pick<ChannelTask, "taskId" | "generation">,
) {
  const owned: Array<OrchestrationV2Run> = [];
  for (const run of records.runs.toSorted((left, right) => left.ordinal - right.ordinal)) {
    const intent = yield* resolveSessionRun(sql, threadId, records, run.id);
    if (intent?.task_id === task.taskId && intent.task_generation === task.generation)
      owned.push(run);
  }
  return owned;
});

/** Whether a task runs in a GOAT Bot session, before and after it is bound to one. */
export const isSessionTask = (task: ChannelTask) =>
  task.worker === undefined
    ? task.kind === "turn" && task.target !== undefined && task.target.remote === undefined
    : task.worker.host === undefined && isGoatBotSessionThreadId(task.worker.threadId);

export interface SessionRow {
  readonly conversation_id: string;
  readonly generation: number;
  readonly binding_key: string;
  readonly thread_id: ThreadId;
  readonly state: "starting" | "active" | "retired";
  /** The task generation that started this session; its launch is recovered for it alone. */
  readonly task_id: ChannelTaskId | null;
  readonly task_generation: number | null;
  readonly sharing: string;
  readonly context_text: string | null;
  readonly version: number;
}

/** The session rows and message intents, read and written under the caller's transaction. */
export const sessionStore = (sql: SqlClient.SqlClient) => {
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const currentRow = (key: string) =>
    sql<SessionRow>`
      SELECT * FROM channel_bot_sessions WHERE binding_key = ${key} AND state != 'retired'
    `.pipe(Effect.map((rows) => rows[0]));

  const setState = (row: SessionRow, state: SessionRow["state"]) =>
    nowIso.pipe(
      Effect.flatMap(
        (now) => sql`
          UPDATE channel_bot_sessions SET state = ${state}, version = version + 1,
            retired_at = ${state === "retired" ? now : null}
          WHERE conversation_id = ${row.conversation_id} AND generation = ${row.generation}
            AND version = ${row.version}
        `,
      ),
    );

  const touch = (threadId: ThreadId) =>
    nowIso.pipe(
      Effect.flatMap(
        (now) =>
          sql`UPDATE channel_bot_sessions SET last_request_at = ${now} WHERE thread_id = ${threadId}`,
      ),
    );

  const writeIntent = (
    threadId: ThreadId,
    messageId: MessageId,
    task: ChannelTask,
    kind: SessionIntent["kind"],
  ) =>
    nowIso.pipe(
      Effect.flatMap(
        (now) => sql`
          INSERT INTO channel_bot_session_runs
            (thread_id, message_id, task_id, task_generation, kind, created_at)
          VALUES (${threadId}, ${messageId}, ${task.taskId}, ${task.generation}, ${kind}, ${now})
          ON CONFLICT (thread_id, message_id) DO NOTHING
        `,
      ),
    );

  const recordRun = (
    threadId: ThreadId,
    messageId: MessageId,
    run: OrchestrationV2Run,
    steered: boolean,
  ) =>
    steered
      ? sql`UPDATE channel_bot_session_runs SET steered_into_run_id = ${run.id}
            WHERE thread_id = ${threadId} AND message_id = ${messageId}`
      : sql`UPDATE channel_bot_session_runs SET run_id = ${run.id}
            WHERE thread_id = ${threadId} AND message_id = ${messageId} AND run_id IS NULL`;
  return { currentRow, setState, touch, writeIntent, recordRun };
};
