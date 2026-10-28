/**
 * channelBotSessionRuns - which task a GOAT Bot session run serves.
 *
 * Every message GOAT sends into a session is recorded before the send. A run belongs to the task
 * its own message was recorded for; a delegated completion or restart continuation belongs to the
 * task of the run it continues. Channel services route reports, child work and stops by this.
 *
 * @module channelBotSessionRuns
 */
import {
  type ChannelTask,
  type ChannelTaskId,
  isGoatBotSessionThreadId,
  type OrchestrationV2Run,
  type RunId,
  type ThreadId,
} from "@goat/contracts";
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
export const sessionIntentFor = (sql: SqlClient.SqlClient, threadId: string, messageId: string) =>
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
