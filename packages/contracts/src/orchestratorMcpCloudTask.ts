import * as Schema from "effect/Schema";

import { IsoDateTime } from "./baseSchemas.ts";
import { OrchestrationV2CloudTask } from "./orchestrationV2.ts";

/** A cloud agent run as delegate_task and the thread tools show it. */
export const OrchestratorMcpCloudTask = Schema.Struct({
  taskId: Schema.String.check(Schema.isMaxLength(512)),
  status: OrchestrationV2CloudTask.fields.status,
  tracking: OrchestrationV2CloudTask.fields.tracking,
  url: Schema.optional(Schema.String.check(Schema.isMaxLength(2048))),
  prUrl: Schema.optional(Schema.String.check(Schema.isMaxLength(2048))),
  branch: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
  progress: Schema.optional(Schema.String.check(Schema.isMaxLength(1000))),
  summary: Schema.optional(Schema.String.check(Schema.isMaxLength(4000))),
  localChangesExcluded: Schema.Boolean,
  localChangesIncluded: OrchestrationV2CloudTask.fields.localChangesIncluded,
  error: Schema.optional(Schema.String.check(Schema.isMaxLength(1000))),
  updatedAt: IsoDateTime,
});
export type OrchestratorMcpCloudTask = typeof OrchestratorMcpCloudTask.Type;
