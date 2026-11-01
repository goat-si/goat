import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ScheduledTaskId,
  ThreadId,
} from "./baseSchemas.ts";
import { ScheduledTask, ScheduledTaskRunStatus, ScheduledTaskSchedule } from "./scheduledTask.ts";
import { OrchestratorMcpReconcileFields } from "./orchestratorMcpReconcile.ts";

export const OrchestratorMcpScheduledTask = Schema.Struct({
  scheduledTaskId: ScheduledTaskId,
  title: Schema.String,
  prompt: Schema.String,
  enabled: Schema.Boolean,
  projectId: ProjectId,
  boundThreadId: Schema.NullOr(ThreadId),
  schedule: ScheduledTaskSchedule,
  notificationPolicy: Schema.optional(Schema.String),
  nextRunAt: Schema.NullOr(IsoDateTime),
  lastRunStatus: ScheduledTaskRunStatus,
  lastRun: ScheduledTask.fields.lastRun,
  runCount: Schema.optional(NonNegativeInt),
  lastRunAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  /** For webhook tasks: the public GOAT Connect URL, shown only to a caller that may start the task's runs. */
  webhookUrl: Schema.optional(Schema.String).annotate({
    description:
      "Public URL for the sender. Absent: no GOAT Connect tunnel, or this caller may not start the task's runs; webhookUrlUnavailableReason then says why.",
  }),
  webhookUrlUnavailableReason: Schema.optional(Schema.String).annotate({
    description: "Why webhookUrl is absent and what the user can do.",
  }),
  webhookSignature: Schema.optional(Schema.Literals(["none", "set"])).annotate({
    description: "Whether requests must carry a valid signature.",
  }),
  ...OrchestratorMcpReconcileFields.scheduledTask,
});
export type OrchestratorMcpScheduledTask = typeof OrchestratorMcpScheduledTask.Type;

export const OrchestratorMcpDeleteScheduledTaskInput = Schema.Struct({
  scheduledTaskId: ScheduledTaskId,
});
export type OrchestratorMcpDeleteScheduledTaskInput =
  typeof OrchestratorMcpDeleteScheduledTaskInput.Type;

export const OrchestratorMcpDeleteScheduledTaskResult = Schema.Struct({
  scheduledTaskId: ScheduledTaskId,
  deleted: Schema.Boolean,
});
export type OrchestratorMcpDeleteScheduledTaskResult =
  typeof OrchestratorMcpDeleteScheduledTaskResult.Type;
