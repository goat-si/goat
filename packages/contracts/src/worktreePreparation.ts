import { OrchestrationV2ThreadLaunchWorkspaceStrategy } from "./orchestrationV2Launch.ts";
import * as Schema from "effect/Schema";
import { CommandId, RunId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const WorktreePreparationBasePin = Schema.Struct({
  commitSha: Schema.String,
  baseRefName: Schema.String,
  checkoutBranch: Schema.optionalKey(TrimmedNonEmptyString),
});
export type WorktreePreparationBasePin = typeof WorktreePreparationBasePin.Type;

export const ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE = "workspace_preparation_failed";

export const PreparedRunPinBase = Schema.Struct({
  type: Schema.Literal("prepared-run.pin-base"),
  commandId: CommandId,
  threadId: ThreadId,
  runId: RunId,
  basePin: WorktreePreparationBasePin,
  workspaceStrategy: Schema.optional(OrchestrationV2ThreadLaunchWorkspaceStrategy),
});
