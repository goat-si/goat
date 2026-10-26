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
  nextRunAt: Schema.NullOr(IsoDateTime),
  lastRunStatus: ScheduledTaskRunStatus,
  lastRun: ScheduledTask.fields.lastRun,
  runCount: Schema.optional(NonNegativeInt),
  lastRunAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  /** For webhook tasks: the public GOAT Connect URL, shown only to a caller that may start the task's runs. */
  webhookUrl: Schema.optional(Schema.String).annotate({
    description:
      "Public URL to give the sender. Absent when this environment has no GOAT Connect managed tunnel or this caller may not start the task's runs; webhookUrlUnavailableReason then says why.",
  }),
  webhookUrlUnavailableReason: Schema.optional(Schema.String).annotate({
    description:
      "For a webhook task without webhookUrl: why it is absent and what the user can do.",
  }),
  webhookSignature: Schema.optional(Schema.Literals(["none", "set"])).annotate({
    description: "Whether requests must carry a valid signature.",
  }),
  ...OrchestratorMcpReconcileFields.scheduledTask,
});
export type OrchestratorMcpScheduledTask = typeof OrchestratorMcpScheduledTask.Type;
