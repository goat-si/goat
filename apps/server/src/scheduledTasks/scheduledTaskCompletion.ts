import type { OrchestrationV2Run } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import type { ScheduledTaskRuns } from "./ScheduledTaskRuns.ts";

const decodeReport = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

type Attribution = Effect.Success<
  ReturnType<ScheduledTaskRuns["Service"]["resolveBatchAttributions"]>
>[number];
export const decideScheduledTaskCompletions = Effect.fn("ScheduledTaskCompletion.decideBatch")(
  function* (runs: ReadonlyArray<OrchestrationV2Run>, firings: ReadonlyArray<Attribution>) {
    const sql = yield* SqlClient.SqlClient;
    const policies = new Map<
      string,
      { notification_policy: string; thread_id: string | null } | undefined
    >();
    const decisions = new Map<string, "notify" | "silent">();
    for (const run of runs) {
      if (run.status !== "completed") {
        decisions.set(run.id, "notify");
        continue;
      }
      const applicable = firings.filter(
        (f) => f.run?.id === run.id && f.run.threadId === run.threadId,
      );
      if (applicable.length === 0) {
        decisions.set(run.id, "notify");
        continue;
      }
      const rows = yield* sql<{
        report_json: string;
      }>`SELECT report_json FROM thread_run_results WHERE thread_id=${run.threadId} AND run_id=${run.id}`;
      const report = Option.getOrUndefined(decodeReport(rows[0]?.report_json ?? "{}")) ?? {};
      let notify =
        report.outcome === "failed" ||
        report.outcome === "blocked" ||
        report.outcome === "cancelled";
      for (const firing of applicable) {
        const key = `${firing.taskId}:${firing.taskCreatedAt}`;
        if (!policies.has(key)) {
          const rows = yield* sql<{
            notification_policy: string;
            thread_id: string | null;
          }>`SELECT notification_policy,thread_id FROM scheduled_tasks WHERE task_id=${firing.taskId} AND created_at=${firing.taskCreatedAt}`;
          policies.set(key, rows[0]);
          if (
            rows[0] === undefined ||
            !["all_runs", "failed_runs_only", "important_updates"].includes(
              rows[0].notification_policy,
            )
          )
            yield* Effect.logWarning("Scheduled completion uses default notification policy", {
              reason: rows[0] === undefined ? "missing_task" : "unknown_policy",
            });
        }
        const task = policies.get(key);
        const suppress =
          task?.notification_policy === "failed_runs_only" ||
          (task?.notification_policy === "important_updates" &&
            task.thread_id === run.threadId &&
            report.outcome === "succeeded" &&
            report.notificationRelevance === "no_update" &&
            report.runId === run.id &&
            run.activeAttemptId !== null &&
            report.expectedAttemptId === run.activeAttemptId);
        if (!suppress) notify = true;
      }
      decisions.set(run.id, notify ? "notify" : "silent");
    }
    return decisions;
  },
);
