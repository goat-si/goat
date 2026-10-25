import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { OrchestratorMcpHost } from "./orchestratorMcp.ts";
import { RuntimeMode } from "./providerPolicy.ts";

/**
 * A fleet goal is durable desired state that the goal controller reconciles, as designed in
 * docs/internals/agentic-k8s.md (ADR-0016). `generation` moves only with the spec, title or
 * pause; `status.observedGeneration` names the spec the status describes.
 */

export const FleetGoalId = TrimmedNonEmptyString.check(Schema.isMaxLength(120)).pipe(
  Schema.brand("FleetGoalId"),
);
export type FleetGoalId = typeof FleetGoalId.Type;

/** Who owns fleet work: "goal:<id>" for a goal's workers, "thread:<id>" for a thread's own. */
export const FleetOwnerKey = TrimmedNonEmptyString.check(
  Schema.isPattern(/^(goal|thread):.+$/),
).pipe(Schema.brand("FleetOwnerKey"));
export type FleetOwnerKey = typeof FleetOwnerKey.Type;

/** A null host is this machine; other entries are SSH host aliases. */
const FleetHost = Schema.NullOr(OrchestratorMcpHost);

export const HostSelector = Schema.Struct({
  hosts: Schema.optional(Schema.Array(FleetHost).check(Schema.isMaxLength(32))),
  exclude: Schema.optional(Schema.Array(FleetHost).check(Schema.isMaxLength(32))),
});
export type HostSelector = typeof HostSelector.Type;

export const FleetGoalKind = Schema.Literals(["pr_bundle", "issue_set", "thread_set", "custom"]);
export type FleetGoalKind = typeof FleetGoalKind.Type;

export const FleetGoalOwner = Schema.Struct({
  kind: Schema.Literals(["thread", "mcp_client"]),
  threadId: Schema.NullOr(ThreadId),
  /**
   * "client:<auth session id>" for an outside MCP client owner. The session id is all the goal
   * keeps of the client's credential; its live grant is read again whenever the goal acts.
   */
  mcpOwner: Schema.NullOr(Schema.String),
  /** Captured at apply, lowered by an update, never raised by the controller. */
  runtimeModeCeiling: RuntimeMode,
});
export type FleetGoalOwner = typeof FleetGoalOwner.Type;

export const FleetGoalProject = Schema.Struct({
  host: FleetHost,
  projectId: Schema.NullOr(ProjectId),
  cwd: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(1024))),
});
export type FleetGoalProject = typeof FleetGoalProject.Type;

export const FleetGoalTarget = Schema.Union([
  Schema.Struct({ type: Schema.Literal("issue"), number: PositiveInt }),
  Schema.Struct({ type: Schema.Literal("pull_request"), number: PositiveInt }),
  Schema.Struct({
    type: Schema.Literal("branch"),
    name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  }),
  Schema.Struct({
    type: Schema.Literal("prompt"),
    key: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
    text: TrimmedNonEmptyString.check(Schema.isMaxLength(4000)),
  }),
]);
export type FleetGoalTarget = typeof FleetGoalTarget.Type;

export const FleetGoalWorkspace = Schema.Struct({
  baseRef: TrimmedNonEmptyString,
  /** Each attempt gets its own branch: <branchPrefix>/s<slot>-a<attempt>. */
  branchPrefix: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  startFromOrigin: Schema.Boolean,
});
export type FleetGoalWorkspace = typeof FleetGoalWorkspace.Type;

export const FLEET_GOAL_HARD_MAX_WORKERS = 8;

export const FleetGoalWorkersSpec = Schema.Struct({
  /** Desired live slots. Ignored when perTarget is true. */
  count: NonNegativeInt.check(Schema.isLessThanOrEqualTo(FLEET_GOAL_HARD_MAX_WORKERS)),
  /** One slot per target instead of count. */
  perTarget: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  hostSelector: HostSelector.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  modelSelection: ModelSelection,
  /** A fallback chain name from settings; null uses the settings default. */
  fallbackChain: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /** Clamped to the owner's ceiling. */
  runtimeMode: RuntimeMode,
  /** {{target}}, {{branch}}, {{attempt}} and {{previousAttempt}} are replaced. */
  promptTemplate: TrimmedNonEmptyString.check(Schema.isMaxLength(20000)),
  workspace: FleetGoalWorkspace,
  onHostLost: Schema.Literals(["reschedule", "wait"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("reschedule" as const)),
  ),
});
export type FleetGoalWorkersSpec = typeof FleetGoalWorkersSpec.Type;

export const FleetGoalDoneWhen = Schema.Struct({
  type: Schema.Literals([
    "pull_requests_merged",
    "checks_green",
    "thread_reported_result",
    "issues_closed",
  ]),
});
export type FleetGoalDoneWhen = typeof FleetGoalDoneWhen.Type;

export const FleetGoalLimits = Schema.Struct({
  maxWorkers: PositiveInt.check(Schema.isLessThanOrEqualTo(FLEET_GOAL_HARD_MAX_WORKERS)).pipe(
    Schema.withDecodingDefault(Effect.succeed(3)),
  ),
  maxAttemptsPerWorker: PositiveInt.check(Schema.isLessThanOrEqualTo(10)).pipe(
    Schema.withDecodingDefault(Effect.succeed(3)),
  ),
  /** Runs the goal may start or continue, across all workers. */
  maxTurns: Schema.NullOr(PositiveInt).pipe(Schema.withDecodingDefault(Effect.succeed(40))),
  maxWallClockMs: Schema.NullOr(PositiveInt).pipe(
    Schema.withDecodingDefault(Effect.succeed(24 * 60 * 60 * 1000)),
  ),
  /** Counted only where the provider reports usage. */
  maxTokens: Schema.NullOr(PositiveInt).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
});
export type FleetGoalLimits = typeof FleetGoalLimits.Type;

export const FleetGoalSpec = Schema.Struct({
  kind: FleetGoalKind,
  project: FleetGoalProject,
  /** owner/name. Needed to observe pull requests and issues. */
  repo: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(200))).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  targets: Schema.Array(FleetGoalTarget).check(Schema.isMaxLength(50)),
  workers: FleetGoalWorkersSpec,
  doneWhen: Schema.Array(FleetGoalDoneWhen).check(Schema.isMinLength(1), Schema.isMaxLength(4)),
  limits: FleetGoalLimits.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  paused: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type FleetGoalSpec = typeof FleetGoalSpec.Type;

export const FleetGoalPhase = Schema.Literals([
  "pending",
  "progressing",
  "blocked",
  "degraded",
  "succeeded",
  "failed",
  "paused",
  "deleting",
]);
export type FleetGoalPhase = typeof FleetGoalPhase.Type;

export const GoalConditionType = Schema.Literals([
  "Ready",
  "Progressing",
  "Blocked",
  "Degraded",
  "BudgetExhausted",
  "Done",
]);
export type GoalConditionType = typeof GoalConditionType.Type;

export const GoalCondition = Schema.Struct({
  type: GoalConditionType,
  status: Schema.Literals(["True", "False", "Unknown"]),
  /** CamelCase, such as HostUnreachable, NeedsHuman or ChecksFailing. */
  reason: TrimmedNonEmptyString,
  message: Schema.String,
  observedGeneration: NonNegativeInt,
  lastTransitionTime: IsoDateTime,
});
export type GoalCondition = typeof GoalCondition.Type;

export const GoalWorkerState = Schema.Literals([
  "placing",
  "launching",
  "launch_unknown",
  "running",
  "needs_human",
  "stalled",
  "succeeded",
  "failed",
  "superseded",
]);
export type GoalWorkerState = typeof GoalWorkerState.Type;

export const GoalWorkerPullRequest = Schema.Struct({
  number: PositiveInt,
  state: Schema.Literals(["open", "merged", "closed"]),
  checks: Schema.NullOr(Schema.Literals(["pending", "passing", "failing"])),
});
export type GoalWorkerPullRequest = typeof GoalWorkerPullRequest.Type;

export const GoalWorkerStatus = Schema.Struct({
  slot: NonNegativeInt,
  /** The target key this slot owns, such as "issue:12"; null when slots are counted. */
  target: Schema.NullOr(Schema.String),
  /** Fencing token: a new attempt gets a new branch, and older attempts are stale. */
  attempt: PositiveInt,
  host: FleetHost,
  threadId: Schema.NullOr(ThreadId),
  branch: Schema.NullOr(Schema.String),
  modelSelection: ModelSelection,
  state: GoalWorkerState,
  pullRequest: Schema.NullOr(GoalWorkerPullRequest),
  lastActivityAt: Schema.NullOr(IsoDateTime),
  launchClientRequestId: Schema.String,
});
export type GoalWorkerStatus = typeof GoalWorkerStatus.Type;

export const GoalUsage = Schema.Struct({
  turns: NonNegativeInt,
  tokens: Schema.NullOr(NonNegativeInt),
  startedAt: Schema.NullOr(IsoDateTime),
});
export type GoalUsage = typeof GoalUsage.Type;

export const FleetGoalStatus = Schema.Struct({
  phase: FleetGoalPhase,
  observedGeneration: NonNegativeInt,
  conditions: Schema.Array(GoalCondition),
  workers: Schema.Array(GoalWorkerStatus),
  usage: GoalUsage,
  lastReconcileAt: Schema.NullOr(IsoDateTime),
  nextReconcileAt: Schema.NullOr(IsoDateTime),
  /** Consecutive failed passes; drives the backoff. */
  failures: NonNegativeInt,
});
export type FleetGoalStatus = typeof FleetGoalStatus.Type;

export const FleetGoal = Schema.Struct({
  id: FleetGoalId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  generation: PositiveInt,
  owner: FleetGoalOwner,
  spec: FleetGoalSpec,
  status: FleetGoalStatus,
  /** Set by goat_goal_delete. Workers are interrupted before the row goes, like a finalizer. */
  deletionRequestedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type FleetGoal = typeof FleetGoal.Type;

export const FleetGoalEvent = Schema.Struct({
  at: IsoDateTime,
  type: Schema.Literals(["Normal", "Warning"]),
  reason: TrimmedNonEmptyString,
  message: Schema.String,
  slot: Schema.NullOr(NonNegativeInt),
  attempt: Schema.NullOr(PositiveInt),
  actionId: Schema.NullOr(Schema.String),
});
export type FleetGoalEvent = typeof FleetGoalEvent.Type;

export const GoatGoalApplyInput = Schema.Struct({
  /** Omit to create. With clientRequestId, a retried create returns the same goal. */
  id: Schema.optional(FleetGoalId),
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  spec: FleetGoalSpec,
  /** Refuse the update with conflict unless the stored generation still matches. */
  expectedGeneration: Schema.optional(PositiveInt),
  clientRequestId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  /** Validate and return the goal as it would be stored, without storing it. */
  dryRun: Schema.optional(Schema.Boolean),
});
export type GoatGoalApplyInput = typeof GoatGoalApplyInput.Type;

export const GoatGoalApplyResult = Schema.Struct({
  goal: FleetGoal,
  created: Schema.Boolean,
  /** False when the stored spec and title were identical, so generation did not move. */
  changed: Schema.Boolean,
  dryRun: Schema.Boolean,
});
export type GoatGoalApplyResult = typeof GoatGoalApplyResult.Type;

export const GoatGoalIdInput = Schema.Struct({ id: FleetGoalId });
export type GoatGoalIdInput = typeof GoatGoalIdInput.Type;

export const GoatGoalGetResult = Schema.Struct({
  goal: FleetGoal,
  /** The last 20 events, oldest first. */
  events: Schema.Array(FleetGoalEvent),
});
export type GoatGoalGetResult = typeof GoatGoalGetResult.Type;

export const GoatGoalResult = Schema.Struct({ goal: FleetGoal });
export type GoatGoalResult = typeof GoatGoalResult.Type;

export const GoatGoalListInput = Schema.Struct({
  phase: Schema.optional(FleetGoalPhase),
  cursor: Schema.optional(NonNegativeInt),
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(50))),
});
export type GoatGoalListInput = typeof GoatGoalListInput.Type;

export const GoatGoalListResult = Schema.Struct({
  goals: Schema.Array(FleetGoal),
  nextCursor: Schema.NullOr(NonNegativeInt),
});
export type GoatGoalListResult = typeof GoatGoalListResult.Type;

export const GoatGoalDeleteInput = Schema.Struct({
  id: FleetGoalId,
  /** Drop the goal now, even while its workers may still run. Threads are never deleted. */
  force: Schema.optional(Schema.Boolean),
});
export type GoatGoalDeleteInput = typeof GoatGoalDeleteInput.Type;

export const GoatGoalDeleteResult = Schema.Struct({
  id: FleetGoalId,
  /** True when the row is gone; false while live workers are being interrupted first. */
  deleted: Schema.Boolean,
  goal: Schema.NullOr(FleetGoal),
  message: Schema.String,
});
export type GoatGoalDeleteResult = typeof GoatGoalDeleteResult.Type;
