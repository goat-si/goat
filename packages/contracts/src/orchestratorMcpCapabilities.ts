import * as Schema from "effect/Schema";

import { NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  ProviderOptionDescriptor,
  ProviderOptionSelection,
  ProviderOptionSelectionValue,
} from "./model.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";

export const OrchestratorMcpCapabilitiesInput = Schema.Struct({
  search: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(200)).annotate({
      description: "Match model ids and labels. Replaces the short list.",
    }),
  ),
});
export type OrchestratorMcpCapabilitiesInput = typeof OrchestratorMcpCapabilitiesInput.Type;

export const OrchestratorMcpModelOption = Schema.Struct({
  id: Schema.String,
  values: Schema.Array(ProviderOptionSelectionValue),
  default: Schema.optional(ProviderOptionSelectionValue),
});
export type OrchestratorMcpModelOption = typeof OrchestratorMcpModelOption.Type;

export const OrchestratorMcpProviderCapability = Schema.Struct({
  executionLocation: Schema.optional(Schema.Literals(["local", "cloud"])),
  followUp: Schema.optional(
    Schema.Struct({
      supported: Schema.Boolean,
      reason: Schema.optional(Schema.String.check(Schema.isMaxLength(1000))),
    }),
  ),
  providerInstanceId: ProviderInstanceId,
  driverKind: ProviderDriverKind,
  displayName: Schema.NullOr(Schema.String),
  models: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      /** Omitted when it only restates the id. A host on an older GOAT sends null. */
      label: Schema.optional(Schema.NullOr(Schema.String)),
      // A host on an older GOAT advertises full option descriptors. Remote delegation
      // still reads its capabilities, so both shapes decode.
      options: Schema.optional(
        Schema.Array(Schema.Union([OrchestratorMcpModelOption, ProviderOptionDescriptor])),
      ),
    }),
  ),
  /** Models left out of `models`: unlisted visible models, or matches past the cap with `search`. */
  omittedModels: Schema.optional(NonNegativeInt),
  runtimeModes: Schema.optional(Schema.Array(RuntimeMode)),
  canRunChildTask: Schema.Boolean,
  canRunCrossProviderChildTask: Schema.Boolean,
  constraints: Schema.Array(Schema.String),
});
export type OrchestratorMcpProviderCapability = typeof OrchestratorMcpProviderCapability.Type;

export const OrchestratorMcpCapabilitiesResult = Schema.Struct({
  parentThreadId: Schema.NullOr(ThreadId),
  inheritedProviderInstanceId: Schema.NullOr(ProviderInstanceId),
  inheritedModel: Schema.NullOr(Schema.String),
  inheritedOptions: Schema.optional(Schema.Array(ProviderOptionSelection)),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  providers: Schema.Array(OrchestratorMcpProviderCapability),
  features: Schema.Struct({
    appOwnedSubagents: Schema.Boolean,
    asyncPolling: Schema.Boolean,
    cancellation: Schema.Boolean,
    batchThreadCreation: Schema.Boolean,
    threadManagement: Schema.Boolean,
    incrementalThreadRead: Schema.Boolean,
    scheduledTasks: Schema.Boolean,
    maxBatchThreads: Schema.Number,
    taskForceStop: Schema.optional(Schema.Boolean),
  }),
});
export type OrchestratorMcpCapabilitiesResult = typeof OrchestratorMcpCapabilitiesResult.Type;
