import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

/**
 * Self-healing vocabulary (docs/internals/agentic-k8s.md, ADR-0017), shared by goat_host_status,
 * the host and reschedule tools, and the goal controller. Conditions follow Kubernetes node
 * conditions: each is a fact about a host with the time it became true, and several can hold.
 */

export const HostConditionType = Schema.Literals([
  "Ready",
  "Unknown",
  "Unreachable",
  "Lost",
  "Cordoned",
  "Draining",
  "VersionMismatch",
  "QuotaExhausted",
]);
export type HostConditionType = typeof HostConditionType.Type;

export const HostCondition = Schema.Struct({
  type: HostConditionType,
  /** When the condition became true (ISO 8601). */
  since: Schema.String,
  /** A machine-readable cause, as in Kubernetes conditions; VersionMismatch uses the host status compatibility verdict. */
  reason: Schema.optional(Schema.String),
  /** The provider instance at its limit, for QuotaExhausted. */
  instanceId: Schema.optional(Schema.String),
  message: Schema.String,
});
export type HostCondition = typeof HostCondition.Type;

const FleetHostAlias = TrimmedNonEmptyString.check(Schema.isMaxLength(255)).annotate({
  description:
    'SSH host alias from goat_ssh_host_list, a linked host name, or "local" for this machine.',
});

const FleetReason = Schema.String.check(Schema.isMaxLength(500));

export const GoatHostCordonInput = Schema.Struct({
  host: FleetHostAlias,
  reason: Schema.optional(FleetReason),
});
export type GoatHostCordonInput = typeof GoatHostCordonInput.Type;

export const GoatHostUncordonInput = Schema.Struct({ host: FleetHostAlias });
export type GoatHostUncordonInput = typeof GoatHostUncordonInput.Type;

export const GoatHostDrainInput = Schema.Struct({
  host: FleetHostAlias,
  reason: Schema.optional(FleetReason),
});
export type GoatHostDrainInput = typeof GoatHostDrainInput.Type;

export const GoatHostScheduleResult = Schema.Struct({
  host: Schema.String,
  cordoned: Schema.Boolean,
  draining: Schema.Boolean,
  conditions: Schema.Array(HostCondition),
  message: Schema.String,
});
export type GoatHostScheduleResult = typeof GoatHostScheduleResult.Type;

export const GoatThreadRescheduleInput = Schema.Struct({
  host: FleetHostAlias.annotate({ description: "Where the thread runs now." }),
  threadId: ThreadId,
  branch: TrimmedNonEmptyString.annotate({
    description:
      "The thread's worktree branch, pushed to origin. The new thread resumes from it on <branch>-a<n+1>.",
  }),
  cwd: TrimmedNonEmptyString.annotate({
    description:
      "The project folder; the same repository is looked up on the target host by its remote, falling back to this path.",
  }),
  targetHost: Schema.optional(FleetHostAlias),
  prompt: Schema.optional(Schema.String.check(Schema.isMaxLength(120000))),
  modelSelection: Schema.optional(ModelSelection),
  reason: FleetReason,
  force: Schema.optional(Schema.Boolean).annotate({
    description:
      "Move off an unreachable host before it counts as Lost (5 minutes). A host that answers is never moved off before its thread is interrupted.",
  }),
});
export type GoatThreadRescheduleInput = typeof GoatThreadRescheduleInput.Type;

export const GoatThreadRescheduleResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("rescheduled"),
    host: Schema.String,
    threadId: ThreadId,
    branch: Schema.String,
    resumedFrom: Schema.Literals(["branch", "replica", "base"]),
    message: Schema.String,
  }),
  Schema.Struct({
    status: Schema.Literal("refused"),
    reason: Schema.Literals([
      "no_capacity",
      "host_still_answers",
      "budget",
      "no_resume_point",
      "unsupported_remote",
      "not_allowed",
    ]),
    message: Schema.String,
  }),
]);
export type GoatThreadRescheduleResult = typeof GoatThreadRescheduleResult.Type;
