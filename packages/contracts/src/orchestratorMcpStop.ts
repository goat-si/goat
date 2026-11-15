import * as Schema from "effect/Schema";

import { IsoDateTime, NodeId, ThreadId } from "./baseSchemas.ts";

/** goat#2338: the parent's Force stop of its own task child once that child ignored Stop. */
export const OrchestratorMcpTaskForce = Schema.optional(Schema.Boolean).annotate({
  description:
    "Only after a cancel left the child stop=unresponsive (task.read): kill its agent and end the run. Parent only.",
});

export const OrchestratorMcpTaskCancelResult = Schema.Struct({
  taskId: NodeId,
  status: Schema.Literals(["cancel_requested", "completed", "failed", "cancelled", "interrupted"]),
  /** A forced stop's outcome. Older hosts never force and never send it. */
  forceStop: Schema.optional(
    Schema.Struct({
      outcome: Schema.Literals(["killed", "released", "releasing", "shared"]),
      sharedWithThreadIds: Schema.Array(ThreadId),
      note: Schema.String,
    }),
  ),
});
export type OrchestratorMcpTaskCancelResult = typeof OrchestratorMcpTaskCancelResult.Type;

/** A Stop its provider did not confirm in time. Older hosts omit it; older callers ignore it. */
export const OrchestratorMcpRunStop = Schema.Struct({
  state: Schema.Literal("unresponsive"),
  since: IsoDateTime,
}).annotate({
  description:
    "The run did not end after Stop. It stays open and keeps its lane slot until the provider ends it, a person uses Force stop, or its parent cancels the task with force: true.",
});
export type OrchestratorMcpRunStop = typeof OrchestratorMcpRunStop.Type;
