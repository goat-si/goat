import {
  idleCompactionOf,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type RunId,
  type ThreadId,
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

// Events that can change which run answered last or what it answered. Anything else keeps the
// stored excerpt, including thread payloads, which echo older values and seed nothing.
export const changesLatestAnswer = (event: OrchestrationV2DomainEvent) =>
  // A fork's creation payload copies its source's excerpt from beyond the fork point.
  event.type === "thread.created" ||
  event.type === "run.created" ||
  event.type === "run.updated" ||
  event.type === "run-attempt.created" ||
  event.type === "run-attempt.updated" ||
  // Streaming text and other nodes change many times a second and never change the answer.
  (event.type === "node.updated" && event.payload.kind === "assistant_message") ||
  (event.type === "message.updated" &&
    event.payload.role === "assistant" &&
    !event.payload.streaming) ||
  // An idle compaction's prompt and its compaction item decide whether its run counts.
  (event.type === "message.updated" && idleCompactionOf(event.payload) !== undefined) ||
  (event.type === "turn-item.updated" && event.payload.type === "compaction");

const byId = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
const at = (time: DateTime.Utc) => DateTime.toEpochMillis(time);

/**
 * The thread's latest answer: the newest non-blank assistant message of its most recently
 * completed run, said by the finishing attempt's root turn or one of its own answer nodes. Native
 * subagents answer under their own nodes, and idle compactions and rolled back runs do not count.
 */
export function latestAnswerExcerpt(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "attempts" | "nodes" | "messages">,
  isIdleRun: (run: OrchestrationV2Run) => boolean,
): string | undefined {
  const run = projection.runs
    .flatMap((candidate) =>
      candidate.status === "completed" && candidate.completedAt !== null && !isIdleRun(candidate)
        ? [{ run: candidate, completedAt: at(candidate.completedAt) }]
        : [],
    )
    .toSorted(
      (left, right) => left.completedAt - right.completedAt || left.run.ordinal - right.run.ordinal,
    )
    .at(-1)?.run;
  if (run === undefined) return undefined;
  const root =
    projection.attempts.find((attempt) => attempt.id === run.activeAttemptId)?.rootNodeId ??
    run.rootNodeId;
  const answers = projection.messages
    .filter(
      (message) =>
        message.runId === run.id &&
        message.role === "assistant" &&
        !message.streaming &&
        (message.nodeId === root || parentOf(projection.nodes, message.nodeId) === root),
    )
    .toSorted((left, right) => at(left.createdAt) - at(right.createdAt) || byId(left.id, right.id));
  for (const answer of answers.toReversed()) {
    const excerpt = answerExcerpt(answer.text);
    if (excerpt !== undefined) return excerpt;
  }
  return undefined;
}

// A node that has not arrived yet has no parent to match, in SQL as in memory.
const MISSING_NODE = Symbol("missing-node");
function parentOf(
  nodes: OrchestrationV2ThreadProjection["nodes"],
  nodeId: OrchestrationV2ThreadProjection["messages"][number]["nodeId"],
) {
  const node = nodes.find((candidate) => candidate.id === nodeId);
  return node === undefined ? MISSING_NODE : node.parentNodeId;
}

export const withExcerpt = (
  thread: OrchestrationV2AppThread,
  excerpt: string | undefined,
): OrchestrationV2AppThread => {
  const { latestAnswerExcerpt: _previous, ...rest } = thread;
  return excerpt === undefined ? rest : { ...rest, latestAnswerExcerpt: excerpt };
};

/** A thread payload upsert keeps the row's own excerpt, the way withExcerpt keeps the projection's. */
export const latestAnswerPayload = (sql: SqlClient.SqlClient, payload: Statement.Fragment) =>
  sql`CASE WHEN json_type(orchestration_v2_projection_threads.payload_json,'$.latestAnswerExcerpt') IS NULL
    THEN json_remove(${payload},'$.latestAnswerExcerpt')
    ELSE json_set(${payload},'$.latestAnswerExcerpt',
      json_extract(orchestration_v2_projection_threads.payload_json,'$.latestAnswerExcerpt')) END`;

/** Mirrors latestAnswerExcerpt for the SQL projection, after the event's own rows are written. */
export const recordLatestAnswer = Effect.fn("ProjectionLatestAnswer.record")(function* (
  sql: SqlClient.SqlClient,
  event: OrchestrationV2DomainEvent,
) {
  if (!changesLatestAnswer(event)) return;
  const shell = makeShellThreadRows(sql);
  const runs = yield* sql<{ readonly run_id: RunId; readonly root_node_id: string | null }>`
    SELECT r.run_id, COALESCE(
      (SELECT a.root_node_id FROM orchestration_v2_projection_run_attempts a
        WHERE a.attempt_id = json_extract(r.payload_json,'$.activeAttemptId')),
      json_extract(r.payload_json,'$.rootNodeId')) AS root_node_id
    FROM orchestration_v2_projection_runs r
    WHERE r.thread_id = ${event.threadId} AND r.status = 'completed'
      AND r.completed_at IS NOT NULL AND NOT ${shell.isIdleCompactionRun("r")}
    ORDER BY r.completed_at DESC, r.ordinal DESC
    LIMIT 1`;
  const run = runs[0];
  const answers =
    run === undefined
      ? []
      : yield* sql<{ readonly text: string | null }>`
          SELECT json_extract(m.payload_json,'$.text') AS text
          FROM orchestration_v2_projection_messages m
          LEFT JOIN orchestration_v2_projection_nodes n ON n.node_id = m.node_id
          WHERE m.run_id = ${run.run_id} AND m.role = 'assistant' AND m.streaming = 0
            AND (m.node_id IS ${run.root_node_id}
              OR (n.node_id IS NOT NULL AND n.parent_node_id IS ${run.root_node_id}))
          ORDER BY m.created_at DESC, m.message_id DESC`;
  let excerpt: string | undefined;
  for (const answer of answers) {
    excerpt = answerExcerpt(answer.text ?? "");
    if (excerpt !== undefined) break;
  }
  yield* writeExcerpt(sql, event.threadId, excerpt);
});

const writeExcerpt = (sql: SqlClient.SqlClient, threadId: ThreadId, excerpt: string | undefined) =>
  excerpt === undefined
    ? sql`UPDATE orchestration_v2_projection_threads
        SET payload_json = json_remove(payload_json,'$.latestAnswerExcerpt')
        WHERE thread_id = ${threadId} AND json_type(payload_json,'$.latestAnswerExcerpt') IS NOT NULL`
    : sql`UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json,'$.latestAnswerExcerpt',${excerpt})
        WHERE thread_id = ${threadId}`;
