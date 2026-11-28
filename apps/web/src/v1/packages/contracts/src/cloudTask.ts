import * as Schema from "effect/Schema";
import { IsoDateTime, RunId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** A provider task that runs in its vendor's cloud, as GOAT persists it on the provider thread. */
export const OrchestrationV2CloudTask = Schema.Struct({
  taskId: TrimmedNonEmptyString,
  // Providers persist the app run whose vendor submission was accepted.
  acceptedAppRunId: Schema.optional(RunId),
  url: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  status: Schema.Literals(["submitting", "running", "succeeded", "failed", "cancelled", "unknown"]),
  tracking: Schema.Literals(["live", "polled", "link-only"]),
  progress: Schema.optional(Schema.String),
  summary: Schema.optional(Schema.String),
  prUrl: Schema.optional(Schema.String),
  branch: Schema.optional(Schema.String),
  source: Schema.Struct({
    repository: TrimmedNonEmptyString,
    branch: TrimmedNonEmptyString,
    sha: Schema.optional(TrimmedNonEmptyString),
  }),
  localChangesExcluded: Schema.Boolean,
  localChangesIncluded: Schema.optional(Schema.Boolean),
  error: Schema.optional(Schema.String),
  /**
   * The provider read the run's own prompt ending in a terminal API error, so the prompt reached
   * the vendor and its turn is over. Counts only with status "failed"; providers drop it from every
   * later write of the task, so it never outlives the next submission.
   */
  confirmedTerminalError: Schema.optional(Schema.Literal(true)),
  updatedAt: IsoDateTime,
  /**
   * The vendor run that stopped on an unexpected error and that GOAT retried once on its own.
   * Present means this app run already spent its automatic retry.
   */
  autoRetriedFromTaskId: Schema.optional(TrimmedNonEmptyString),
  /**
   * "registered": launched outside GOAT and registered afterwards. The first run attaches to
   * the task and never submits a prompt.
   */
  attach: Schema.optional(Schema.Literal("registered")),
});
export type OrchestrationV2CloudTask = typeof OrchestrationV2CloudTask.Type;
