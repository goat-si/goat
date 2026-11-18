import { Atom } from "effect/reactivity";

import {
  loadedMobileGoatBotRef,
  pickMobileGoatBotHomeEnvironment,
} from "../features/goat-bot/goatBotHomeMode";
import { mobileGoatBotEnvironmentInput } from "../features/goat-bot/mobileGoatBotEnvironments";
import { mobilePreferencesAtom } from "./preferences";
import { environmentPresentations } from "./presentation";

/**
 * The computer whose bot Home this device opens, picked as the roster and Home pick it. Threads
 * follows Home only there; every other computer keeps the listed-work rule.
 */
export const mobileGoatBotHomeEnvironmentIdAtom = Atom.make((get) => {
  const botRef = loadedMobileGoatBotRef(get(mobilePreferencesAtom));
  // Until preferences load the Bots switch cannot open Home, so Home governs no computer.
  if (botRef === undefined) return null;
  const environments = [...get(environmentPresentations.presentationsAtom)].map(
    ([environmentId, presentation]) =>
      mobileGoatBotEnvironmentInput({
        environmentId,
        label: presentation.entry.target.label,
        connection: presentation.connection,
        serverConfig: presentation.serverConfig,
      }),
  );
  return pickMobileGoatBotHomeEnvironment(environments, botRef)?.environmentId ?? null;
}).pipe(Atom.withLabel("mobile-goat-bot-home-environment"));
