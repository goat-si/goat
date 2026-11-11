import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import { EnvironmentAuthorizationError } from "./auth.ts";
import { CommandId, NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2CreationSource,
  OrchestrationV2ThreadForkSourcePoint,
} from "./orchestrationV2.ts";

/** Where a fork works: the source's checkout, or a new GOAT-managed worktree started from it. */
export const OrchestrationV2ThreadForkWorkspace = Schema.Union([
  Schema.Struct({ type: Schema.Literal("current") }),
  Schema.Struct({
    type: Schema.Literal("worktree"),
    branch: Schema.optional(TrimmedNonEmptyString),
    /** Carry the source checkout's uncommitted changes into the worktree. Default true. */
    includeUncommitted: Schema.optional(Schema.Boolean),
  }),
]);
export type OrchestrationV2ThreadForkWorkspace = typeof OrchestrationV2ThreadForkWorkspace.Type;

export const OrchestrationV2ThreadForkInput = Schema.Struct({
  commandId: CommandId,
  creationSource: Schema.optional(OrchestrationV2CreationSource),
  sourceThreadId: ThreadId,
  targetThreadId: ThreadId,
  sourcePoint: OrchestrationV2ThreadForkSourcePoint,
  title: Schema.optional(TrimmedNonEmptyString),
  workspace: OrchestrationV2ThreadForkWorkspace,
});
export type OrchestrationV2ThreadForkInput = typeof OrchestrationV2ThreadForkInput.Type;

export const OrchestrationV2ThreadForkWorktreeResult = Schema.Struct({
  branch: TrimmedNonEmptyString,
  worktreePath: TrimmedNonEmptyString,
  /** The source checkout's HEAD the worktree started from; null when a retry replays the first result. */
  baseCommit: Schema.NullOr(TrimmedNonEmptyString),
  /** What happened to the source's uncommitted changes; null when a retry replays the first result. */
  uncommitted: Schema.NullOr(Schema.Literals(["carried", "none", "left"])),
  /** "unknown" when a retry replays the first result: setup starts only on the call that created the fork. */
  setupScript: Schema.Literals(["started", "no-script", "failed", "unknown"]),
});
export type OrchestrationV2ThreadForkWorktreeResult =
  typeof OrchestrationV2ThreadForkWorktreeResult.Type;

export const OrchestrationV2ThreadForkResult = Schema.Struct({
  sequence: NonNegativeInt,
  targetThreadId: ThreadId,
  worktree: Schema.optional(OrchestrationV2ThreadForkWorktreeResult),
});
export type OrchestrationV2ThreadForkResult = typeof OrchestrationV2ThreadForkResult.Type;

export const OrchestrationV2ThreadForkRefusal = Schema.Literals([
  "side_chat",
  "scratch_project",
  "cloud_provider",
  "checkout_missing",
  "not_git_repository",
  "branch_exists",
  "uncommitted_unsupported",
  "worktree_failed",
  "fork_failed",
  /** The server does not serve orchestration.forkThread, so it cannot make a worktree. */
  "unsupported",
]);
export type OrchestrationV2ThreadForkRefusal = typeof OrchestrationV2ThreadForkRefusal.Type;

export class OrchestrationV2ThreadForkError extends Schema.TaggedError<OrchestrationV2ThreadForkError>()(
  "OrchestrationV2ThreadForkError",
  {
    commandId: CommandId,
    sourceThreadId: ThreadId,
    reason: OrchestrationV2ThreadForkRefusal,
    message: Schema.String,
    /** Set when a checkout was kept after an unknown outcome. */
    retainedWorktreePath: Schema.optional(TrimmedNonEmptyString),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/** rpc.ts adds it to the core group, whose middleware authorizes it. */
export const WsOrchestrationV2ForkThreadRpc = Rpc.make(ORCHESTRATION_V2_WS_METHODS.forkThread, {
  payload: OrchestrationV2ThreadForkInput,
  success: OrchestrationV2ThreadForkResult,
  error: Schema.Union([OrchestrationV2ThreadForkError, EnvironmentAuthorizationError]),
});
