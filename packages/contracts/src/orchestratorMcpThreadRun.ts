import * as Schema from "effect/Schema";

import { IsoDateTime, PositiveInt, RunAttemptId, RunId } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { OrchestrationV2RunStartHold } from "./orchestrationV2.ts";
import { OrchestrationV2RunStatus } from "./orchestrationV2RunStatus.ts";
import { OrchestrationV2RunTerminationCause } from "./orchestrationV2RunTermination.ts";

/** Set while a starting run waits for another Codex turn on its thread; older hosts omit it. */
const startHold = Schema.optional(OrchestrationV2RunStartHold);

export const OrchestratorMcpThreadRun = Schema.Struct({
  runId: RunId,
  ordinal: PositiveInt,
  status: OrchestrationV2RunStatus,
  terminationCause: Schema.optional(OrchestrationV2RunTerminationCause),
  startHold,
  providerInstanceId: ProviderInstanceId,
  model: Schema.String,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestratorMcpThreadRun = typeof OrchestratorMcpThreadRun.Type;

export const OrchestratorMcpThreadStatusRun = Schema.Struct({
  runId: RunId,
  activeAttemptId: Schema.optional(Schema.NullOr(RunAttemptId)),
  status: OrchestrationV2RunStatus,
  terminationCause: Schema.optional(OrchestrationV2RunTerminationCause),
  startHold,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestratorMcpThreadStatusRun = typeof OrchestratorMcpThreadStatusRun.Type;
