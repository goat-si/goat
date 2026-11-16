import * as Effect from "effect/Effect";
import {
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_TEXT_GENERATION_MODEL,
  DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  isModelTextGenerationCapable,
  isProviderAvailable,
  isProviderTextGenerationCapable,
  type ModelSelection,
  type ProviderDriverKind,
  type ServerProvider,
  type ServerSettings,
} from "@goat/contracts";
import type { ProviderInstance } from "@goat/provider-core/server/driver";
import { fallbackTextGenerationModelSelection } from "@goat/shared/serverSettings";

import type * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";

const checkedSnapshot = Effect.fn("TextGeneration.checkedSnapshot")(function* (
  instance: ProviderInstance,
) {
  if (instance.snapshot.isAwaitingFirstCheck !== undefined) {
    if (yield* instance.snapshot.isAwaitingFirstCheck) return undefined;
  }
  return yield* instance.snapshot.getSnapshot;
});

const providerDefaultModel = (driver: ProviderDriverKind) =>
  DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER[driver] ??
  DEFAULT_MODEL_BY_PROVIDER[driver] ??
  DEFAULT_TEXT_GENERATION_MODEL;

/**
 * Moves off a model or provider the status marks unable to generate text (a Pi extension
 * model), as the Settings picker does, so the model Settings shows is the one that runs.
 * Before the first status check the saved model runs.
 */
export const resolveTextGenerationCapableSelection = Effect.fn(
  "TextGeneration.resolveCapableSelection",
)(function* (
  registry: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"],
  settings: ServerSettings,
  selection: ModelSelection,
) {
  if (Object.hasOwn(settings.textGenerators, selection.instanceId)) return selection;
  const instance = yield* registry.getInstance(selection.instanceId);
  const snapshot = instance === undefined ? undefined : yield* checkedSnapshot(instance);
  if (snapshot === undefined) return selection;
  const ownDefault = {
    instanceId: selection.instanceId,
    model: providerDefaultModel(snapshot.driver),
  };
  if (isProviderTextGenerationCapable(snapshot)) {
    return isModelTextGenerationCapable(snapshot, selection.model) ? selection : ownDefault;
  }
  const others = new Map<string, ServerProvider>();
  for (const other of yield* registry.listInstances) {
    if (other.instanceId === selection.instanceId) continue;
    const otherSnapshot = yield* checkedSnapshot(other);
    if (otherSnapshot !== undefined) others.set(other.instanceId, otherSnapshot);
  }
  const fallback = fallbackTextGenerationModelSelection(
    settings.providerInstances,
    (instanceId) => {
      const candidate = others.get(instanceId);
      return (
        candidate?.enabled === true &&
        isProviderAvailable(candidate) &&
        isProviderTextGenerationCapable(candidate)
      );
    },
    { defaultModelSelection: settings.defaultModelSelection },
  );
  return fallback ?? ownDefault;
});
