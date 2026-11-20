import {
  isOrchestrationV2WorkActive,
  type OrchestrationV2Run,
  type RunId,
  type ThreadId,
} from "@goat/contracts";
import { subagentHoldsCompletion } from "@goat/provider-core/server/subagentProjection";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
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

/** A newer accepted report for this generation also answers a rejection in an earlier run. */
export const botReportStillDue = (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  orderedRuns: ReadonlyArray<RunId>,
) =>
  sql<{ due: number }>`
    SELECT pending.key IS NOT NULL AS due
    FROM json_each(${JSON.stringify(orderedRuns)}) AS owned
    LEFT JOIN channel_runtime_state AS pending ON pending.key = ${prefix} || owned.value
    LEFT JOIN thread_run_results AS report ON report.thread_id = ${threadId} AND report.run_id = owned.value
    WHERE pending.key IS NOT NULL OR report.run_id IS NOT NULL
    ORDER BY owned.key DESC LIMIT 1
  `.pipe(Effect.map((rows) => rows[0]?.due === 1));
