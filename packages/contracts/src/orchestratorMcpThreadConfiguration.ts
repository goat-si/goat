import * as Schema from "effect/Schema";

import { NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";
import { OrchestratorMcpHost } from "./orchestratorMcp.ts";

const resultHost = Schema.optional(Schema.String);
const clientRequestId = TrimmedNonEmptyString.check(Schema.isMaxLength(256)).annotate({
  description: "Reuse it to retry the same call. A new call gets a new key.",
});

export const OrchestratorMcpThreadConfigurationInput = Schema.Struct({
  threadId: Schema.optional(ThreadId),
  host: Schema.optional(OrchestratorMcpHost),
});
export type OrchestratorMcpThreadConfigurationInput =
  typeof OrchestratorMcpThreadConfigurationInput.Type;

export const OrchestratorMcpThreadConfigurationResult = Schema.Struct({
  host: resultHost,
  threadId: ThreadId,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
});
export type OrchestratorMcpThreadConfigurationResult =
  typeof OrchestratorMcpThreadConfigurationResult.Type;

export const OrchestratorMcpThreadConfigureInput = Schema.Struct({
  ...OrchestratorMcpThreadConfigurationInput.fields,
  modelSelection: ModelSelection,
  clientRequestId: Schema.optional(clientRequestId),
});
export type OrchestratorMcpThreadConfigureInput = typeof OrchestratorMcpThreadConfigureInput.Type;

export const OrchestratorMcpThreadConfigureResult = Schema.Struct({
  host: resultHost,
  sequence: NonNegativeInt,
});
export type OrchestratorMcpThreadConfigureResult = typeof OrchestratorMcpThreadConfigureResult.Type;
