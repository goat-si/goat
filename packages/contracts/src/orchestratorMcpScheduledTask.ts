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

export const OrchestratorMcpLastRunError = Schema.optional(Schema.String).annotate({
  description:
    "Why the last run did not complete: the provider's reason, or how the run ended. Absent when there is none or on older hosts.",
});

export const OrchestratorMcpScheduledTask = Schema.Struct({
  scheduledTaskId: ScheduledTaskId,
  title: Schema.String,
  prompt: Schema.String,
  enabled: Schema.Boolean,
  projectId: ProjectId,
  boundThreadId: Schema.NullOr(ThreadId),
  freshSession: Schema.Boolean,
  schedule: ScheduledTaskSchedule,
  notificationPolicy: Schema.optional(Schema.String),
  nextRunAt: Schema.NullOr(IsoDateTime),
  lastRunStatus: ScheduledTaskRunStatus,
  lastRun: ScheduledTask.fields.lastRun,
  lastRunError: OrchestratorMcpLastRunError,
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

export const OrchestratorMcpFreshSession = Schema.optional(Schema.Boolean).annotate({
  description:
    "Runs share one thread but each starts a fresh session without earlier runs' context. Unbound: the first run makes the thread.",
});

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

export const OrchestratorMcpListScheduledTasksInput = Schema.Struct({
  projectId: Schema.optional(
    ProjectId.annotate({
      description: "Default: your thread's project, or all outside a thread.",
    }),
  ),
});
export type OrchestratorMcpListScheduledTasksInput =
  typeof OrchestratorMcpListScheduledTasksInput.Type;

export const OrchestratorMcpListScheduledTasksResult = Schema.Struct({
  tasks: Schema.Array(OrchestratorMcpScheduledTask),
});
export type OrchestratorMcpListScheduledTasksResult =
  typeof OrchestratorMcpListScheduledTasksResult.Type;
