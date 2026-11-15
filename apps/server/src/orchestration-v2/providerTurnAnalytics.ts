import type { OrchestrationV2ProviderTurn } from "@goat/contracts";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import { getModelSelectionStringOptionValue } from "@goat/shared/model";
import * as DateTime from "effect/DateTime";

import { BUNDLED_MODEL_MANIFEST } from "../provider/ModelManifest.ts";
import type { ProviderTurnAnalyticsContext } from "./ProviderEventIngestor.ts";

export function providerTurnAnalyticsProperties(input: {
  readonly driver: ProviderAdapter.ProviderAdapterV2Event["driver"];
  readonly providerTurn: OrchestrationV2ProviderTurn;
  readonly context?: ProviderTurnAnalyticsContext;
}): Readonly<Record<string, unknown>> {
  const usage = input.providerTurn.turnTokenUsage;
  const observedModel = usage?.models?.length === 1 ? usage.models[0] : undefined;
  const catalog = BUNDLED_MODEL_MANIFEST.providers?.[input.driver];
  const confirmedModel =
    observedModel === undefined
      ? undefined
      : catalog?.models.find(
          (model) => model.slug === observedModel || model.aliases?.includes(observedModel),
        )?.slug;
  const modelSelection = input.context?.modelSelection;
  const effort = modelSelection
    ? (getModelSelectionStringOptionValue(modelSelection, "reasoningEffort") ??
      getModelSelectionStringOptionValue(modelSelection, "effort"))
    : undefined;
  return {
    provider: input.driver,
    terminalStatus: input.providerTurn.status,
    usageStatus: usage?.usageStatus ?? "unavailable",
    usageScope: usage?.usageScope ?? "main_agent",
    ...(usage ? { hasSubagents: usage.hasSubagents } : {}),
    ...(usage?.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage?.cachedInputTokens === undefined
      ? {}
      : { cachedInputTokens: usage.cachedInputTokens }),
    ...(usage?.cacheCreationTokens === undefined
      ? {}
      : { cacheCreationTokens: usage.cacheCreationTokens }),
    ...(usage?.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
    ...(usage?.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
    ...(confirmedModel ? { model: confirmedModel, mixedModels: false } : {}),
    ...(usage?.models !== undefined && usage.models.length > 1 ? { mixedModels: true } : {}),
    ...(effort ? { effort } : {}),
    ...(input.context?.runtimeMode ? { runtimeMode: input.context.runtimeMode } : {}),
    ...(input.context?.interactionMode ? { interactionMode: input.context.interactionMode } : {}),
    ...input.context?.origin,
    ...(input.providerTurn.startedAt && input.providerTurn.completedAt
      ? {
          durationMs: Math.max(
            0,
            DateTime.toEpochMillis(input.providerTurn.completedAt) -
              DateTime.toEpochMillis(input.providerTurn.startedAt),
          ),
        }
      : {}),
  };
}
