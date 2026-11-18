import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import {
  type ModelSelection,
  type ProjectId,
  type ServerProvider,
  type ServerSettings,
} from "@goat/contracts";
import type { ProviderInstance } from "@goat/provider-core/server/driver";
import { resolveTextGenerationRoute } from "@goat/shared/serverSettings";

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
      const instance = yield* registry.getInstance(selection.instanceId);
      if (
        instance?.snapshot.isAwaitingFirstCheck !== undefined &&
        (yield* instance.snapshot.isAwaitingFirstCheck)
      ) {
        return selection;
      }
      const providers: Array<ServerProvider> = [];
      if (instance !== undefined) providers.push(yield* instance.snapshot.getSnapshot);
      const projectId = yield* TextGenerationProject;
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      let route = resolveTextGenerationRoute(settings, selection, providers, projectId, now);
      if (route.reason === "no_fallback") {
        for (const other of yield* registry.listInstances) {
          if (other.instanceId === selection.instanceId) continue;
          const snapshot = yield* checkedSnapshot(other);
          if (snapshot !== undefined) providers.push(snapshot);
        }
        route = resolveTextGenerationRoute(settings, selection, providers, projectId, now);
      }
      if (route.reason === "saved") {
        yield* Ref.set(lastLogged, null);
      } else if (route.selection !== selection) {
        yield* logFallback(selection, route.selection, route.reason);
      }
      return route.selection;
    });
  },
);
