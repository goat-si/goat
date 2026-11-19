import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const OrchestrationV2ThreadLaunchWorkspaceStrategy = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("root"),
    branch: Schema.optional(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    type: Schema.Literal("existing_worktree"),
    worktreePath: TrimmedNonEmptyString,
    branch: Schema.optional(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    type: Schema.Literal("worktree"),
    baseRef: TrimmedNonEmptyString,
    branch: Schema.optional(TrimmedNonEmptyString),
    startFromOrigin: Schema.optional(Schema.Boolean),
  }),
]);
export type OrchestrationV2ThreadLaunchWorkspaceStrategy =
  typeof OrchestrationV2ThreadLaunchWorkspaceStrategy.Type;

export const WorktreePreparationBasePin = Schema.Struct({
  commitSha: Schema.String,
  baseRefName: Schema.String,
  checkoutBranch: Schema.optionalKey(TrimmedNonEmptyString),
});
export type WorktreePreparationBasePin = typeof WorktreePreparationBasePin.Type;
