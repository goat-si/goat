import { ScheduledTask, ScheduledTaskId, ScheduledTaskRun } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";

import { routineOwnerOf } from "./scheduledBotRoutines.ts";
import { taskError } from "./scheduledTaskError.ts";
import type { ScheduledTaskRow } from "./ScheduledTaskRow.ts";
import type { WebhookOrigin } from "./ScheduledTaskService.ts";
import { iso } from "./Schedule.ts";
import { webhookEndpoint } from "./webhookEndpoint.ts";

const decodeTask = Schema.decodeUnknownEffect(ScheduledTask);
export const decodeTaskId = Schema.decodeUnknownOption(ScheduledTaskId);
const decodeScheduleJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ScheduledTask.fields.schedule),
);
const decodeWorkspaceStrategyJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ScheduledTask.fields.workspaceStrategy),
);
const decodeModelSelectionJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ScheduledTask.fields.modelSelection),
);
const decodeLastRunJson = Schema.decodeUnknownEffect(Schema.fromJsonString(ScheduledTaskRun));

// Runs per task row; list and lookup operations already own the span.

export const decodeRow = Effect.fnUntraced(
  function* (row: ScheduledTaskRow, origin: WebhookOrigin | null = null) {
    const schedule = yield* decodeScheduleJson(row.schedule_json);
    const webhook = schedule.type === "webhook" ? webhookEndpoint(row, origin) : undefined;
    const workspaceStrategy = yield* decodeWorkspaceStrategyJson(row.workspace_strategy_json);
    const modelSelection = yield* decodeModelSelectionJson(row.model_selection_json);
    return yield* decodeTask({
      id: row.task_id,
      title: row.title,
      prompt: row.prompt,
      enabled: row.enabled === 1,
      notificationPolicy: row.notification_policy,
      schedule,
      projectId: row.project_id,
      threadId: row.thread_id,
      threadMode: row.thread_mode,
      workspaceStrategy,
      modelSelection,
      memoryGrantCeiling: row.memory_grant_ceiling ?? "none",
      runtimeMode: row.runtime_mode,
      interactionMode: row.interaction_mode,
      createdBy: row.created_by,
      creationSource: row.creation_source,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      nextRunAt: row.next_run_at,
      lastRunAt: row.last_run_at,
      lastRunStatus: row.last_run_status,
      ...(row.last_run_json == null
        ? {}
        : { lastRun: yield* decodeLastRunJson(row.last_run_json) }),
      lastRunError: row.last_run_error,
      runCount: row.run_count,
      ...(webhook === undefined ? {} : { webhook }),
      ...(Option.isSome(routineOwnerOf(row.owner_json)) ? { goatBotRoutine: true } : {}),
    });
  },
  (effect, row, _origin?) =>
    effect.pipe(
      Effect.mapError((cause) => {
        const taskId = decodeTaskId(row.task_id);
        return taskError("Could not decode schedule task row.", {
          ...(Option.isSome(taskId) ? { taskId: taskId.value } : {}),
          cause,
        });
      }),
    ),
);

export const listDueTasks = Effect.fn("ScheduledTaskService.listDueTasks")(function* (
  now: DateTime.DateTime,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<ScheduledTaskRow>`
    SELECT t.*,r.snapshot_json AS last_run_json FROM scheduled_tasks t
    LEFT JOIN scheduled_task_runs r ON r.firing_id=t.last_firing_id AND r.task_id=t.task_id AND r.task_created_at=t.created_at
    WHERE t.enabled = 1 AND t.next_run_at IS NOT NULL AND t.next_run_at <= ${iso(now)}
      AND NOT EXISTS (SELECT 1 FROM scheduled_task_runs busy WHERE busy.task_id=t.task_id AND busy.task_created_at=t.created_at
        AND (busy.dispatch_bookkept_at IS NULL OR busy.dispatch_status='dispatching'))
    ORDER BY t.next_run_at ASC, t.task_id ASC
  `.pipe(NodeSqliteClient.readOnly);
  const tasks: ScheduledTask[] = [];
  for (const row of rows) {
    const decoded = yield* Effect.result(decodeRow(row));
    if (Result.isSuccess(decoded)) {
      const task = decoded.success;
      // next_run_at is a freeform string at the schema level; a stored value
      // that cannot parse as a DateTime would defect the poll below, so the
      // row is skipped here like any other corrupt row.
      if (task.nextRunAt === null || Option.isSome(DateTime.make(task.nextRunAt))) {
        tasks.push(task);
      } else {
        yield* Effect.logWarning("Skipping schedule task row with invalid next_run_at", {
          taskId: row.task_id,
        });
      }
    } else {
      yield* Effect.logWarning("Skipping undecodable schedule task row", {
        taskId: row.task_id,
        cause: decoded.failure,
      });
    }
  }
  return tasks;
});
