import type {
  OrchestrationV2AppThread,
  OrchestrationV2DomainEvent,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
  RunId,
  ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type * as Statement from "effect/sql/Statement";
import { makeShellThreadRows } from "./ProjectionShellThreadRows.ts";

const MAX_EXCERPT = 160;

/** The answer on one line, cut to fit the excerpt without splitting a character. */
export function answerExcerpt(text: string): string | undefined {
  const line = text.replace(/\s+/g, " ").trim();
  if (line === "") return undefined;
  if (line.length <= MAX_EXCERPT) return line;
  let cut = "";
  for (const char of line) {
    if (cut.length + char.length > MAX_EXCERPT - 1) break;
    cut += char;
  }
  return cut.trimEnd() + "…";
}

const completedRun = (event: OrchestrationV2DomainEvent): OrchestrationV2Run | null =>
  (event.type === "run.created" || event.type === "run.updated") &&
  event.payload.status === "completed" &&
  event.payload.completedAt !== null
    ? event.payload
    : null;

// The run's answer comes from the attempt that finished it; native subagents' nodes are excluded.
function answerNodeId(
  run: OrchestrationV2Run,
  attempts: OrchestrationV2ThreadProjection["attempts"],
) {
  return (
    attempts.find((attempt) => attempt.id === run.activeAttemptId)?.rootNodeId ?? run.rootNodeId
  );
}

/** The excerpt a completed run leaves on its thread, or undefined when it answered nothing. */
function latestAnswerOfRun(
  projection: Pick<OrchestrationV2ThreadProjection, "attempts" | "messages">,
  run: OrchestrationV2Run,
): string | undefined {
  const nodeId = answerNodeId(run, projection.attempts);
  const answer = projection.messages
    .filter(
      (message) =>
        message.runId === run.id &&
        message.role === "assistant" &&
        !message.streaming &&
        message.nodeId === nodeId &&
        message.text.trim() !== "",
    )
    .toSorted(
      (left, right) =>
        DateTime.toEpochMillis(left.createdAt) - DateTime.toEpochMillis(right.createdAt) ||
        left.id.localeCompare(right.id),
    )
    .at(-1);
  return answer === undefined ? undefined : answerExcerpt(answer.text);
}

/** The thread after an event, carrying the excerpt of a run that just completed. */
export function withLatestAnswer(
  projection: Pick<OrchestrationV2ThreadProjection, "attempts" | "messages">,
  thread: OrchestrationV2AppThread,
  event: OrchestrationV2DomainEvent,
  idleRunIds: ReadonlySet<RunId>,
): OrchestrationV2AppThread {
  const run = completedRun(event);
  if (run === null || idleRunIds.has(run.id)) return thread;
  const excerpt = latestAnswerOfRun(projection, run);
  return excerpt === undefined ? thread : { ...thread, latestAnswerExcerpt: excerpt };
}

// The projection owns the excerpt: a thread payload seeds it only when it creates the projection.
export const preserveLatestAnswer = (
  current: OrchestrationV2AppThread | undefined,
  next: OrchestrationV2AppThread,
): OrchestrationV2AppThread => {
  const { latestAnswerExcerpt: _echoed, ...rest } = next;
  const kept = current === undefined ? next.latestAnswerExcerpt : current.latestAnswerExcerpt;
  return kept === undefined ? rest : { ...rest, latestAnswerExcerpt: kept };
};

/** Mirrors preserveLatestAnswer for a thread row upsert: an existing row keeps its own excerpt. */
export const latestAnswerPayload = (sql: SqlClient.SqlClient, payload: Statement.Fragment) =>
  sql`CASE WHEN json_type(orchestration_v2_projection_threads.payload_json,'$.latestAnswerExcerpt') IS NULL
    THEN json_remove(${payload},'$.latestAnswerExcerpt')
    ELSE json_set(${payload},'$.latestAnswerExcerpt',
      json_extract(orchestration_v2_projection_threads.payload_json,'$.latestAnswerExcerpt')) END`;

export const recordLatestAnswers = Effect.fn("ProjectionLatestAnswer.record")(function* (
  sql: SqlClient.SqlClient,
  events: ReadonlyArray<OrchestrationV2DomainEvent>,
) {
  const shell = makeShellThreadRows(sql);
  for (const event of events) {
    const run = completedRun(event);
    if (run === null) continue;
    const idle = yield* sql`SELECT 1 FROM orchestration_v2_projection_runs r
      WHERE r.run_id = ${run.id} AND ${shell.isIdleCompactionRun("r")}`;
    if (idle.length > 0) continue;
    const rows = yield* sql<{ readonly text: string }>`
      SELECT json_extract(m.payload_json,'$.text') AS text
      FROM orchestration_v2_projection_messages m
      WHERE m.thread_id = ${run.threadId} AND m.run_id = ${run.id}
        AND m.role = 'assistant' AND m.streaming = 0
        AND m.node_id IS COALESCE(
          (SELECT root_node_id FROM orchestration_v2_projection_run_attempts
            WHERE attempt_id = ${run.activeAttemptId}),
          ${run.rootNodeId})
        AND TRIM(json_extract(m.payload_json,'$.text')) <> ''
      ORDER BY m.created_at DESC, m.message_id DESC
      LIMIT 1`;
    const excerpt = rows[0] === undefined ? undefined : answerExcerpt(rows[0].text);
    if (excerpt !== undefined) yield* writeExcerpt(sql, run.threadId, excerpt);
  }
});

const writeExcerpt = (sql: SqlClient.SqlClient, threadId: ThreadId, excerpt: string) =>
  sql`UPDATE orchestration_v2_projection_threads
    SET payload_json = json_set(payload_json,'$.latestAnswerExcerpt',${excerpt})
    WHERE thread_id = ${threadId}`;
