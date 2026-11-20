import {
  isOrchestrationV2WorkActive,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
  type RunId,
  type ThreadId,
} from "@goat/contracts";
import { subagentHoldsCompletion } from "@goat/provider-core/server/subagentProjection";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

import { resolveSessionRun } from "../channels/channelBotSessionRuns.ts";
import type { ThreadManagementServiceShape } from "../orchestration-v2/ThreadManagementService.ts";

export const botReportAwaitsDelegates = Effect.fn("ThreadResults.botReportAwaitsDelegates")(
  function* (
    threads: Pick<ThreadManagementServiceShape, "getThreadRecords">,
    sql: SqlClient.SqlClient,
    threadId: ThreadId,
    runs: ReadonlyArray<OrchestrationV2Run>,
    run: OrchestrationV2Run,
  ) {
    const { subagents } = yield* threads.getThreadRecords(threadId, ["subagents"], {
      omitSettledSubagents: true,
    });
    const outstanding = subagents.filter(
      (child) =>
        child.origin === "app_owned" &&
        child.promotedAt === undefined &&
        subagentHoldsCompletion(child),
    );
    if (outstanding.length === 0) return false;
    const { messages } = yield* threads.getThreadRecords(threadId, ["messages"], {
      messageIds: runs.map((item) => item.userMessageId),
      messageRoles: ["user"],
    });
    const wake = messages.find((message) => message.id === run.userMessageId)?.delegatedCompletion;
    const otherRuns = new Set<RunId>();
    for (const child of outstanding) {
      if (wake?.taskIds.includes(child.id) && !isOrchestrationV2WorkActive(child.status)) continue;
      if (child.runId === run.id || child.runId === wake?.parentRunId) return true;
      if (child.runId !== null) otherRuns.add(child.runId);
    }
    if (otherRuns.size === 0) return false;
    const records = { runs, messages };
    const owner = yield* resolveSessionRun(sql, threadId, records, run.id);
    if (!owner) return false;
    for (const other of otherRuns) {
      const candidate = yield* resolveSessionRun(sql, threadId, records, other);
      if (
        candidate?.task_id === owner.task_id &&
        candidate.task_generation === owner.task_generation
      )
        return true;
    }
    return false;
  },
);

const encodeRunIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const prefix = "delegated-report-due:";
const key = (runId: RunId) => prefix + runId;

export const markBotReportDue = (sql: SqlClient.SqlClient, runId: RunId) =>
  DateTime.now.pipe(
    Effect.flatMap(
      (at) =>
        sql`INSERT INTO channel_runtime_state (key, value_json, updated_at)
        VALUES (${key(runId)}, 'true', ${DateTime.formatIso(at)}) ON CONFLICT(key) DO NOTHING`,
    ),
  );

export const clearBotReportDue = (sql: SqlClient.SqlClient, runId: RunId) =>
  sql`DELETE FROM channel_runtime_state WHERE key = ${key(runId)}`;

/** A restart can finish its predecessor's work. A new user turn must supply its own report. */
export const settlementReportRun = Effect.fn("ThreadResults.settlementReportRun")(function* (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  current: OrchestrationV2Run,
  ownedRuns: ReadonlyArray<OrchestrationV2Run>,
  children: ReadonlyArray<OrchestrationV2Subagent>,
) {
  const delegates = children.filter((child) => child.origin === "app_owned" && !child.promotedAt);
  const rows = yield* sql<{ runId: RunId; reportedAt: string | null; due: number }>`
    SELECT owned.value AS runId, report.reported_at AS reportedAt, pending.key IS NOT NULL AS due
    FROM json_each(${encodeRunIds(ownedRuns.map((run) => run.id))}) AS owned
    LEFT JOIN channel_runtime_state AS pending ON pending.key = ${prefix} || owned.value
    LEFT JOIN thread_run_results AS report ON report.thread_id = ${threadId} AND report.run_id = owned.value
    WHERE pending.key IS NOT NULL OR report.run_id IS NOT NULL
    ORDER BY owned.key DESC LIMIT 1
  `;
  const latest = rows[0];
  if (latest?.due) return null;
  if (!delegates.length) return current.id;
  if (!latest?.reportedAt) return null;
  const reportedAt = Date.parse(latest.reportedAt);
  if (
    delegates.some(
      (child) => child.completedAt && DateTime.toEpochMillis(child.completedAt) > reportedAt,
    )
  )
    return null;
  let candidate = current.id;
  for (const run of ownedRuns.toReversed()) {
    if (run.id !== candidate) continue;
    if (run.id === latest.runId) return run.id;
    if (!run.restartContinuationOfRunId) break;
    candidate = run.restartContinuationOfRunId;
  }
  return null;
});
