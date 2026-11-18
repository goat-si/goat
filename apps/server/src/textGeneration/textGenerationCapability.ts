import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import {
  isModelTextGenerationCapable,
  isProviderTextGenerationCapable,
  type ModelSelection,
  type ProjectId,
  type ServerProvider,
  type ServerSettings,
} from "@goat/contracts";
import type { ProviderInstance } from "@goat/provider-core/server/driver";
import {
  resolveTextGenerationFallback,
  textGenerationDefaultModel,
} from "@goat/shared/serverSettings";

import type * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";

/** The project the text is for; a fallback skips providers that project turned off. */
export const TextGenerationProject = Context.Reference<ProjectId | null>(
  "goat/textGeneration/TextGenerationProject",
  { defaultValue: () => null },
);

const checkedSnapshot = Effect.fn("TextGeneration.checkedSnapshot")(function* (
  instance: ProviderInstance,
) {
  if (instance.snapshot.isAwaitingFirstCheck !== undefined) {
    if (yield* instance.snapshot.isAwaitingFirstCheck) return undefined;
  }
  return yield* instance.snapshot.getSnapshot;
});

const modelKey = (selection: ModelSelection) => `${selection.instanceId}/${selection.model}`;

/**
 * Moves off a model or provider the status marks unable to generate text (a Pi extension
 * model), as the Settings picker does, so the model Settings shows is the one that runs.
 * Before the first status check the saved model runs. Logs each new fallback once.
 */
export const makeTextGenerationCapableSelection = Effect.fn("TextGeneration.makeCapableSelection")(
  function* (registry: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"]) {
    const lastLogged = yield* Ref.make<string | null>(null);
    const logFallback = Effect.fnUntraced(function* (
      from: ModelSelection,
      to: ModelSelection,
      reason: "model_unsupported" | "provider_unsupported" | "no_fallback",
    ) {
      const key = `${modelKey(from)}>${modelKey(to)}`;
      if ((yield* Ref.getAndSet(lastLogged, key)) === key) return;
      yield* Effect.logInfo("Text generation fell back", {
        from: { instanceId: from.instanceId, model: from.model },
        to: { instanceId: to.instanceId, model: to.model },
        reason,
      });
    });
    return Effect.fn("TextGeneration.resolveCapableSelection")(function* (
      settings: ServerSettings,
      selection: ModelSelection,
    ) {
      if (Object.hasOwn(settings.textGenerators, selection.instanceId)) return selection;
      const instance = yield* registry.getInstance(selection.instanceId);
      const snapshot = instance === undefined ? undefined : yield* checkedSnapshot(instance);
      if (snapshot === undefined) return selection;
      const ownDefault = {
        instanceId: selection.instanceId,
        model: textGenerationDefaultModel(snapshot),
      };
      if (isProviderTextGenerationCapable(snapshot)) {
        if (isModelTextGenerationCapable(snapshot, selection.model)) {
          yield* Ref.set(lastLogged, null);
          return selection;
        }
        yield* logFallback(selection, ownDefault, "model_unsupported");
        return ownDefault;
      }
      const others: Array<ServerProvider> = [];
      for (const other of yield* registry.listInstances) {
        if (other.instanceId === selection.instanceId) continue;
        const otherSnapshot = yield* checkedSnapshot(other);
        if (otherSnapshot !== undefined) others.push(otherSnapshot);
      }
      // The web picker takes the fallback instance's default model, never the thread's custom default.
      const fallback = resolveTextGenerationFallback(settings, others, {
        projectId: yield* TextGenerationProject,
        excludeInstanceId: selection.instanceId,
        now: DateTime.toEpochMillis(yield* DateTime.now),
      });
      const fallbackSnapshot = others.find((other) => other.instanceId === fallback?.instanceId);
      const chosen =
        fallbackSnapshot === undefined
          ? ownDefault
          : {
              instanceId: fallbackSnapshot.instanceId,
              model: textGenerationDefaultModel(fallbackSnapshot),
            };
      yield* logFallback(
        selection,
        chosen,
        fallbackSnapshot === undefined ? "no_fallback" : "provider_unsupported",
      );
      return chosen;
    });
  },
);
