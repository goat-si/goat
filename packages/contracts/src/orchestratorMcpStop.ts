import * as Schema from "effect/Schema";

import { IsoDateTime, NodeId } from "./baseSchemas.ts";

export const OrchestratorMcpTaskCancelResult = Schema.Struct({
  taskId: NodeId,
  status: Schema.Literals(["cancel_requested", "completed", "failed", "cancelled", "interrupted"]),
});
export type OrchestratorMcpTaskCancelResult = typeof OrchestratorMcpTaskCancelResult.Type;

/** A Stop its provider did not confirm in time. Older hosts omit it; older callers ignore it. */
export const OrchestratorMcpRunStop = Schema.Struct({
  state: Schema.Literal("unresponsive"),
  since: IsoDateTime,
}).annotate({
  description:
    "The run did not end after Stop. It stays open and keeps its lane slot until the provider ends it or a person uses Force stop; agents cannot Force stop (goat#2338).",
});
export type OrchestratorMcpRunStop = typeof OrchestratorMcpRunStop.Type;
