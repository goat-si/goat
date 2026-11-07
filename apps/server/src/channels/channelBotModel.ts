/**
 * A bot turn's model: the member's own, then the GOAT Bot setting, then the default. Callers take
 * the first candidate their own check accepts. Main has no own model, so its order is unchanged.
 */
import type { ModelSelection, ServerSettings } from "@goat/contracts";
import { resolveGoatBotModelSelection } from "@goat/shared/serverSettings";
import * as Effect from "effect/Effect";

const botModelCandidates = (
  memberModel: ModelSelection | null,
  settings: ServerSettings,
): ReadonlyArray<ModelSelection> => [
  ...(memberModel === null ? [] : [memberModel]),
  ...(settings.goatBotModelSelection === null ? [] : [settings.goatBotModelSelection]),
];

const botDefaultModel = (settings: ServerSettings) =>
  resolveGoatBotModelSelection({ ...settings, goatBotModelSelection: null });

/** The first candidate `offered` accepts, else the default; a skipped one is logged. */
export const chooseBotModel = Effect.fn("channelBotModel.choose")(function* <E, R>(
  memberModel: ModelSelection | null,
  settings: ServerSettings,
  offered: (selection: ModelSelection) => Effect.Effect<boolean, E, R>,
) {
  for (const candidate of botModelCandidates(memberModel, settings)) {
    if (yield* offered(candidate)) return candidate;
    yield* Effect.logWarning("GOAT Bot model is not available here; trying the next one", {
      instanceId: candidate.instanceId,
      model: candidate.model,
    });
  }
  return botDefaultModel(settings);
});
